import type { PlatformProjectGateway } from "../../../gateway/platform-project-gateway.ts";
import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import type { BotConfiguration } from "../entity/bot-configuration.ts";
import { ManagementError } from "../entity/management-error.ts";
import { type PlatformProject, PlatformProjectError } from "../entity/platform-project.ts";
import type { BootstrapOrigin } from "../entity/project-bootstrap.ts";
import { projectRegion } from "../entity/project-region.ts";
import type { JoiningDevice } from "../storage/identity-storage.ts";
import { randomSecret } from "../storage/identity-storage-common.ts";
import type { ManagedBotStorage } from "../storage/managed-bot-storage.ts";
import type { PlatformProjectStorage } from "../storage/platform-project-storage.ts";
import type { AuthenticationService } from "./authentication-service.ts";

/** The outcome of binding a Machine to a Runtime. */
export type RuntimeBinding = "bound" | "fixed" | "not-found";

export class ManagementService {
    readonly #authentication: AuthenticationService;
    readonly #managedBots: ManagedBotStorage;
    readonly #platformProjects: PlatformProjectStorage;
    readonly #platform: PlatformProjectGateway;
    readonly #credentialKey: CloudBindings["CHAT_CREDENTIAL_KEY"];

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
        const token = await bootstrapToken(this.#credentialKey, userId, project.projectId, origin, signal);
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

    readonly ownsMachine = async (userId: string, botId: string, signal: AbortSignal): Promise<boolean> =>
        await this.#managedBots.ownsBot(userId, botId, signal);

    /** The user's Machine with its Runtime binding (`configuration`, null while unbound), or null when it has none. */
    readonly machine = async (userId: string, botId: string, signal: AbortSignal) =>
        await this.#managedBots.readBot(userId, botId, signal);

    /**
     * Binds the Machine to `runtimeId`. A Machine's binding is fixed: an unbound Machine takes the Runtime once `verify`
     * accepts it, the same Runtime binds again idempotently after `verify`, and any other Runtime is refused before
     * `verify` runs. Of two concurrent first bindings only one is recorded; the other is answered from the result.
     */
    readonly bindRuntime = async (
        userId: string,
        botId: string,
        runtimeId: BotConfiguration["runtimeId"],
        verify: () => Promise<void>,
        signal: AbortSignal,
    ): Promise<RuntimeBinding> => {
        const decide = (configuration: BotConfiguration | null): RuntimeBinding | "unbound" =>
            configuration === null ? "unbound" : configuration.runtimeId === runtimeId ? "bound" : "fixed";
        const current = await this.#managedBots.readBot(userId, botId, signal);
        if (current === null) {
            return "not-found";
        }
        const decision = decide(current.configuration);
        if (decision === "fixed") {
            return decision;
        }
        await verify();
        if (
            decision === "bound" ||
            (await this.#managedBots.bindUnbound(userId, botId, { runtimeId }, Date.now(), signal))
        ) {
            return "bound";
        }
        const settled = await this.#managedBots.readBot(userId, botId, signal);
        if (settled === null) {
            return "not-found";
        }
        const outcome = decide(settled.configuration);
        return outcome === "unbound" ? "not-found" : outcome;
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

    /**
     * The credential derives from the link and the browser's redemption key, so repeating a redemption whose reply was
     * lost returns the same identity. A request without a key gets a credential no retry can name.
     */
    readonly redeemTransfer = async (
        code: string,
        replaces: string | null,
        joining: JoiningDevice,
        redemptionKey: string | null,
        signal: AbortSignal,
    ) => {
        // The version and input encoding are part of the persisted retry contract; keep them stable.
        const token = await derivedToken(
            this.#credentialKey,
            ["morty-transfer-redemption-v1", code, redemptionKey ?? randomSecret()],
            signal,
        );
        const identity = await this.#authentication.redeemTransfer(code, replaces, joining, token, signal);
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
async function bootstrapToken(
    serverKey: CloudBindings["CHAT_CREDENTIAL_KEY"],
    userId: string,
    projectId: string,
    origin: BootstrapOrigin,
    signal: AbortSignal,
) {
    // The versions and input encodings are part of the persisted retry contract; keep them stable.
    switch (origin.kind) {
        case "created":
            return await derivedToken(
                serverKey,
                ["morty-anonymous-user-v1", userId, projectId, origin.creationKey],
                signal,
            );
        case "replacement":
            return await derivedToken(
                serverKey,
                ["morty-project-replacement-v1", userId, origin.previousProjectId, projectId, origin.token],
                signal,
            );
    }
}

async function derivedToken(
    serverKey: CloudBindings["CHAT_CREDENTIAL_KEY"],
    input: readonly string[],
    signal: AbortSignal,
) {
    if (serverKey === undefined) {
        throw new Error("Deriving a credential needs the Project object's key.");
    }
    const secret = await serverKey(signal);
    const key = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(input)));
    return `morty_anon_v1_${btoa(String.fromCharCode(...new Uint8Array(signed)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "")}`;
}

/** A Project identity owns exactly one Machine; ambiguous stored state must not select another target. */
function servedBot<Bot>(bots: readonly Bot[]): Bot | undefined {
    if (bots.length > 1) {
        throw new ManagementError("BOT_STATE_INVALID", "Machine state is invalid. Set up a fresh Morty identity.", 409);
    }
    return bots[0];
}
