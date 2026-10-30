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
        const { botId, displayName } = await this.#provisionUserBot(identity.userId, signal);
        return { ...identity, bot: { botId, displayName } };
    };

    /** The one Machine Morty serves a user; setup and every browser handoff resolve it here. Reading never creates. */
    readonly userBot = async (userId: string, signal: AbortSignal) => {
        const served = servedBot(await this.#managedBots.listBots(userId, signal));
        if (served === undefined) {
            throw new ManagementError("BOT_NOT_FOUND", "Machine is unavailable.", 404);
        }
        return served;
    };

    /**
     * Gives the user its Machine unless it already has one. Only identity bootstrap and transfer redemption call this;
     * both are retried writes, so repeating them returns the same Machine.
     */
    readonly #provisionUserBot = async (userId: string, signal: AbortSignal) => {
        const served = servedBot(await this.#managedBots.listBots(userId, signal));
        if (served !== undefined) {
            return served;
        }
        const bot = { botId: `bot_${crypto.randomUUID()}`, displayName: "My Machine" };
        await this.#managedBots.saveClaim(userId, bot, Date.now(), signal);
        return { ...bot, runtimeId: null };
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
        const { botId } = await this.#provisionUserBot(identity.userId, signal);
        return { ...identity, botId };
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

/**
 * Earlier releases could give a user several Machines, so the Machine bound to a Runtime is served before one that
 * never got a Runtime, and the oldest such Machine wins. Setup binds only this Machine and a binding is permanent, so
 * once it has a Runtime it remains the one served.
 */
function servedBot<Bot extends { readonly runtimeId: string | null }>(bots: readonly Bot[]): Bot | undefined {
    return bots.find((bot) => bot.runtimeId !== null) ?? bots[0];
}
