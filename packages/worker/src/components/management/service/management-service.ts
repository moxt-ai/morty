import * as v from "valibot";
import type { PlatformProjectGateway } from "../../../gateway/platform-project-gateway.ts";
import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import { ManagementError } from "../entity/management-error.ts";
import { type PlatformProject, PlatformProjectError } from "../entity/platform-project.ts";
import type { BootstrapOrigin } from "../entity/project-bootstrap.ts";
import { projectRegion } from "../entity/project-region.ts";
import type { ManagedBotStorage } from "../storage/managed-bot-storage.ts";
import type { PlatformProjectStorage } from "../storage/platform-project-storage.ts";
import type { AuthenticationService } from "./authentication-service.ts";

export class ManagementService {
    readonly #authentication: AuthenticationService;
    readonly #managedBots: ManagedBotStorage;
    readonly #platformProjects: PlatformProjectStorage;
    readonly #platform: PlatformProjectGateway;
    readonly #credentialKey: unknown;

    constructor(cx: {
        readonly config: { readonly bindings: CloudBindings };
        readonly services: { readonly authentication: AuthenticationService };
        readonly storages: {
            readonly managedBots: ManagedBotStorage;
            readonly platformProjects: PlatformProjectStorage;
        };
        readonly gateways: { readonly platformProjects: PlatformProjectGateway };
    }) {
        this.#authentication = cx.services.authentication;
        this.#managedBots = cx.storages.managedBots;
        this.#platformProjects = cx.storages.platformProjects;
        this.#platform = cx.gateways.platformProjects;
        this.#credentialKey = cx.config.bindings.CHAT_CREDENTIAL_KEY;
    }

    /**
     * Every step reuses what an earlier attempt committed, and the credential derives from the bootstrap's origin, so
     * repeating the same bootstrap completes it and returns the same identity instead of creating another.
     */
    readonly initializeAnonymousUser = async (
        userId: string,
        project: PlatformProject,
        signal: AbortSignal,
        origin: BootstrapOrigin,
    ) => {
        const token = await bootstrapToken(this.#credentialKey, userId, project.projectId, origin);
        const identity = await this.#authentication.createAnonymous(userId, project.projectId, signal, token);
        const { appId } = this.#platform.configuration();
        await this.#platformProjects.save(userId, appId, project, signal);
        const bot = await this.provisionUserBot(identity.userId, signal);
        return { ...identity, bot };
    };

    /** Gives the user its first Machine unless it already has one. */
    readonly provisionUserBot = async (userId: string, signal: AbortSignal) => {
        const existing = (await this.#managedBots.listBots(userId, signal))[0];
        if (existing !== undefined) {
            return existing;
        }
        const bot = { botId: `bot_${crypto.randomUUID()}`, displayName: "My Machine" };
        await this.#managedBots.saveClaim(userId, bot, Date.now(), signal);
        return bot;
    };

    readonly listBots = async (userId: string, signal: AbortSignal) => await this.#managedBots.listBots(userId, signal);

    readonly createBot = async (userId: string, displayName: string, signal: AbortSignal) => {
        const bot = { botId: `bot_${crypto.randomUUID()}`, displayName };
        await this.#managedBots.saveClaim(userId, bot, Date.now(), signal);
        return bot;
    };

    readonly readBot = async (userId: string, botId: string, signal: AbortSignal) => {
        const bot = await this.#managedBots.readBot(userId, botId, signal);
        if (bot === null) {
            throw new ManagementError("BOT_NOT_FOUND", "Machine is unavailable.", 404);
        }
        return {
            botId: bot.botId,
            displayName: bot.displayName,
            instructions: bot.instructions,
            configured: bot.configuration !== null,
        };
    };

    readonly readBotRuntimeBinding = async (userId: string, botId: string, signal: AbortSignal) => {
        const bot = await this.#managedBots.readBot(userId, botId, signal);
        if (bot === null) {
            throw new ManagementError("BOT_NOT_FOUND", "Machine is unavailable.", 404);
        }
        return { botId: bot.botId, runtimeId: bot.configuration?.runtimeId ?? null };
    };

    readonly updateBot = async (
        userId: string,
        botId: string,
        input: { readonly displayName: string; readonly instructions: string },
        signal: AbortSignal,
    ) => {
        await this.readBot(userId, botId, signal);
        if (!(await this.#managedBots.updateBot(userId, botId, input, Date.now(), signal))) {
            throw new ManagementError("BOT_NOT_FOUND", "Machine is unavailable.", 404);
        }
        return await this.readBot(userId, botId, signal);
    };

    readonly deleteBot = async (userId: string, botId: string, signal: AbortSignal): Promise<void> => {
        const result = await this.#managedBots.deleteBot(userId, botId, signal);
        switch (result) {
            case "deleted":
                return;
            case "last-bot":
                throw new ManagementError("LAST_BOT_REQUIRED", "Keep at least one Machine in Morty.", 409);
            case "not-found":
                throw new ManagementError("BOT_NOT_FOUND", "Machine is unavailable.", 404);
        }
    };

    readonly readProject = async (userId: string, signal: AbortSignal) => {
        const { appId } = this.#platform.configuration();
        return await this.#platformProjects.read(userId, appId, signal);
    };

    /** Creates the successor Project for a user whose Project must be replaced, keeping the user. */
    readonly replaceProject = async (userId: string, signal: AbortSignal) => {
        const { appId } = this.#platform.configuration();
        const previous = await this.#platformProjects.read(userId, appId, signal);
        if (previous === null) {
            throw new PlatformProjectError("PROJECT_REQUIRED", "Finish Morty setup before replacing.", 409);
        }
        // A successor needs its own Platform reference: clientReference is unique per (app, reference)
        // and the primary reference is already bound to the previous Project. Keying the reference on
        // the previous Project keeps replacement retries idempotent, as does reusing its placement.
        const reference = `${userId}.${previous.projectId}`;
        const project = await this.#platform.create(
            userId,
            "Morty",
            signal,
            projectRegion(previous.projectId),
            reference,
        );
        return project;
    };

    readonly createRuntimePairing = async (userId: string, idempotencyKey: string, signal: AbortSignal) => {
        const project = await this.#requireProject(userId, signal);
        const pairing = await this.#platform.createPairing(project.projectId, idempotencyKey, signal);
        return pairing;
    };

    readonly readRuntimePairing = async (userId: string, pairingId: string, signal: AbortSignal) => {
        const project = await this.#requireProject(userId, signal);
        return await this.#platform.readPairing(project.projectId, pairingId, signal);
    };

    readonly redeemTransfer = async (code: string, replaces: string | null, signal: AbortSignal) => {
        const identity = await this.#authentication.redeemTransfer(code, replaces, signal);
        if (identity === null) {
            return null;
        }
        const bot = await this.provisionUserBot(identity.userId, signal);
        return { ...identity, botId: bot.botId };
    };

    readonly #requireProject = async (userId: string, signal: AbortSignal) => {
        const project = await this.readProject(userId, signal);
        if (project === null) {
            throw new PlatformProjectError("PROJECT_REQUIRED", "Finish Morty setup before pairing a Runtime.", 409);
        }
        return project;
    };
}

/** The credential a bootstrap issues, derived so that repeating the same bootstrap issues it again. */
async function bootstrapToken(serverKey: unknown, userId: string, projectId: string, origin: BootstrapOrigin) {
    // The versions and input encodings are part of the persisted retry contract; keep them stable.
    switch (origin.kind) {
        case "created":
            return await derivedToken(serverKey, ["morty-anonymous-user-v1", userId, projectId, origin.creationKey]);
        case "replacement":
            return await derivedToken(serverKey, [
                "morty-project-replacement-v1",
                userId,
                origin.previousProjectId,
                projectId,
                origin.token,
            ]);
    }
}

async function derivedToken(serverKey: unknown, input: readonly string[]) {
    const secret = v.parse(v.instance(Uint8Array), serverKey);
    const key = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(input)));
    return `mobius_anon_v2_${btoa(String.fromCharCode(...new Uint8Array(signed)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "")}`;
}
