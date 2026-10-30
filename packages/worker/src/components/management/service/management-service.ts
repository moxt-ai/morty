import * as v from "valibot";
import type { PlatformProjectGateway } from "../../../gateway/platform-project-gateway.ts";
import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import { ManagementError } from "../entity/management-error.ts";
import { type PlatformProject, PlatformProjectError } from "../entity/platform-project.ts";
import type { ReplacementIdentity } from "../entity/project-bootstrap.ts";
import { projectRegion } from "../entity/project-region.ts";
import type { ManagedBotStorage } from "../storage/managed-bot-storage.ts";
import type { PlatformProjectStorage } from "../storage/platform-project-storage.ts";
import type { ProjectLocationHint } from "../util/project-location.ts";
import type { AuthenticationService } from "./authentication-service.ts";

type LocationHint = ProjectLocationHint | undefined;

export class ManagementService {
    readonly #authentication: AuthenticationService;
    readonly #managedBots: ManagedBotStorage;
    readonly #platformProjects: PlatformProjectStorage;
    readonly #platform: PlatformProjectGateway;
    readonly #replacementKey: unknown;

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
        this.#replacementKey = cx.config.bindings.CHAT_REPLACEMENT_KEY;
    }

    readonly initializeAnonymousUser = async (
        userId: string,
        project: PlatformProject,
        signal: AbortSignal,
        replacement?: ReplacementIdentity,
    ) => {
        const token =
            replacement === undefined
                ? undefined
                : await replacementToken(this.#replacementKey, userId, project.projectId, replacement);
        const identity = await this.#authentication.createAnonymous(userId, project.projectId, signal, token);
        const { appId } = this.#platform.configuration();
        await this.#platformProjects.save(userId, appId, project, signal);
        const bot = await this.provisionUserBot(identity.userId, undefined, signal);
        return { ...identity, bot };
    };

    readonly provisionUserBot = async (userId: string, location: LocationHint, signal: AbortSignal) => {
        const existing = (await this.#managedBots.listBots(userId, signal))[0];
        if (existing !== undefined) {
            return existing;
        }
        const { appId } = this.#platform.configuration();
        const project =
            (await this.#platformProjects.read(userId, appId, signal)) ??
            (await this.#platform.create(userId, "Morty", signal, location));
        await this.#platformProjects.save(userId, appId, project, signal);
        signal.throwIfAborted();
        const bot = { botId: `bot_${crypto.randomUUID()}`, displayName: "My Machine" };
        await this.#managedBots.saveClaim(userId, bot, Date.now(), signal);
        return bot;
    };

    readonly listBots = async (userId: string, location: LocationHint, signal: AbortSignal) => {
        await this.provisionUserBot(userId, location, signal);
        return await this.#managedBots.listBots(userId, signal);
    };

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
        const bot = await this.provisionUserBot(identity.userId, undefined, signal);
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

// The version and input encoding are part of the persisted retry contract; keep them stable.
async function replacementToken(
    serverKey: unknown,
    userId: string,
    projectId: string,
    replacement: ReplacementIdentity,
) {
    const secret = v.parse(v.instance(Uint8Array), serverKey);
    const key = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signed = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(
            JSON.stringify([
                "morty-project-replacement-v1",
                userId,
                replacement.previousProjectId,
                projectId,
                replacement.token,
            ]),
        ),
    );
    return `mobius_anon_v2_${btoa(String.fromCharCode(...new Uint8Array(signed)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "")}`;
}
