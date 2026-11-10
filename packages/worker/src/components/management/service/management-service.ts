import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import type { BootstrapOrigin } from "../entity/computer-bootstrap.ts";
import { type ComputerManagement, ComputerManagementError } from "../entity/computer-management.ts";
import { ManagementError } from "../entity/management-error.ts";
import { projectRegion } from "../entity/project-region.ts";
import type { JoiningDevice } from "../storage/identity-storage.ts";
import { randomSecret } from "../storage/identity-storage-common.ts";
import type { ManagedBotStorage } from "../storage/managed-bot-storage.ts";
import { provisionAccount } from "./account-provisioning-service.ts";
import type { AuthenticationService } from "./authentication-service.ts";
import type { LocalComputerService } from "./local-computer-service.ts";

export class ManagementService {
    readonly #authentication: AuthenticationService;
    readonly #managedBots: ManagedBotStorage;
    readonly #computerId: string | undefined;
    readonly #relay: LocalComputerService;
    readonly #credentialKey: CloudBindings["CHAT_CREDENTIAL_KEY"];
    readonly #bindings: CloudBindings;

    constructor(cx: {
        readonly config: { readonly bindings: CloudBindings };
        readonly services: { readonly authentication: AuthenticationService; readonly computers: LocalComputerService };
        readonly storages: {
            readonly managedBots: ManagedBotStorage;
        };
    }) {
        this.#authentication = cx.services.authentication;
        this.#managedBots = cx.storages.managedBots;
        this.#computerId = cx.config.bindings.CHAT_COMPUTER_ID;
        this.#relay = cx.services.computers;
        this.#credentialKey = cx.config.bindings.CHAT_CREDENTIAL_KEY;
        this.#bindings = cx.config.bindings;
    }

    /**
     * Every step reuses what an earlier attempt committed, and the credential derives from the bootstrap's origin, so
     * repeating the same bootstrap completes it and returns the same identity instead of creating another.
     */
    readonly initializeAnonymousUser = async (
        userId: string,
        project: ComputerManagement,
        signal: AbortSignal,
        origin: BootstrapOrigin,
    ) => {
        const token = await bootstrapToken(this.#credentialKey, userId, project.computerId, origin, signal);
        const identity = await this.#authentication.createAnonymous(userId, project.computerId, signal, token);
        const { displayName } = await this.#provisionUserBot(identity.userId, signal);
        return { ...identity, bot: { displayName } };
    };

    /**
     * Gives the user its Machine unless it already has one. Only identity bootstrap and transfer redemption call this;
     * both are retried writes, so repeating them returns the same Machine.
     */
    readonly #provisionUserBot = async (userId: string, signal: AbortSignal) =>
        await this.#managedBots.claimMachine(userId, { displayName: "My Machine" }, Date.now(), signal);

    readonly readBot = async (userId: string, signal: AbortSignal) => {
        const bot = await this.#managedBots.readBot(userId, signal);
        if (bot === null) {
            throw new ManagementError("BOT_NOT_FOUND", "Machine is unavailable.", 404);
        }
        return {
            computerId: bot.configuration?.computerId ?? null,
            displayName: bot.displayName,
            configured: bot.configuration !== null,
        };
    };

    readonly readBotRuntimeBinding = async (userId: string, signal: AbortSignal) => {
        const bot = await this.#managedBots.readBot(userId, signal);
        if (bot === null) {
            throw new ManagementError("BOT_NOT_FOUND", "Machine is unavailable.", 404);
        }
        return { computerId: bot.configuration?.computerId ?? null };
    };

    readonly readProject = async (userId: string, signal: AbortSignal) => {
        const machine = await this.#managedBots.readMachine(userId, signal);
        return machine === null || this.#computerId === undefined
            ? null
            : { computerId: this.#computerId, displayName: machine.displayName };
    };

    /** Creates the successor Project for a user whose Project must be replaced, keeping the user. */
    readonly replaceProject = async (userId: string, signal: AbortSignal) => {
        const previous = await this.readProject(userId, signal);
        if (previous === null) {
            throw new ComputerManagementError("PROJECT_REQUIRED", "Finish Morty setup before replacing.", 409);
        }
        // A successor needs its own Relay reference: clientReference is unique per (app, reference)
        // and the primary reference is already bound to the previous Project. Keying the reference on
        // the previous Project keeps replacement retries idempotent, as does reusing its placement.
        const reference = `${userId}.${previous.computerId}`;
        const project = await provisionAccount(
            this.#bindings,
            userId,
            reference,
            projectRegion(previous.computerId),
            signal,
        );
        return project;
    };

    readonly createRuntimePairing = async (userId: string, idempotencyKey: string, signal: AbortSignal) => {
        const project = await this.#requireProject(userId, signal);
        const pairing = await this.#relay.createPairing(project.computerId, idempotencyKey, signal);
        return pairing;
    };

    readonly readRuntimePairing = async (userId: string, signal: AbortSignal) => {
        const project = await this.#requireProject(userId, signal);
        return await this.#relay.readPairing(project.computerId, signal);
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
        await this.#provisionUserBot(identity.userId, signal);
        return identity;
    };

    readonly #requireProject = async (userId: string, signal: AbortSignal) => {
        const project = await this.readProject(userId, signal);
        if (project === null) {
            throw new ComputerManagementError("PROJECT_REQUIRED", "Finish Morty setup before pairing a Runtime.", 409);
        }
        return project;
    };
}

/** The credential a bootstrap issues, derived so that repeating the same bootstrap issues it again. */
async function bootstrapToken(
    serverKey: CloudBindings["CHAT_CREDENTIAL_KEY"],
    userId: string,
    computerId: string,
    origin: BootstrapOrigin,
    signal: AbortSignal,
) {
    // The versions and input encodings are part of the persisted retry contract; keep them stable.
    switch (origin.kind) {
        case "created":
            return await derivedToken(
                serverKey,
                ["morty-anonymous-user-v1", userId, computerId, origin.creationKey],
                signal,
            );
        case "replacement":
            return await derivedToken(
                serverKey,
                ["morty-project-replacement-v1", userId, origin.previousComputerId, computerId, origin.token],
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
