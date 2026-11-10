import type { ComputerManagementGateway } from "../../../gateway/computer-management-gateway.ts";
import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import type { BootstrapOrigin } from "../entity/computer-bootstrap.ts";
import { type ComputerManagement, ComputerManagementError } from "../entity/computer-management.ts";
import { ManagementError } from "../entity/management-error.ts";
import { projectRegion } from "../entity/project-region.ts";
import type { JoiningDevice } from "../storage/identity-storage.ts";
import { randomSecret } from "../storage/identity-storage-common.ts";
import type { ManagedBotStorage } from "../storage/managed-bot-storage.ts";
import type { AuthenticationService } from "./authentication-service.ts";

export class ManagementService {
    readonly #authentication: AuthenticationService;
    readonly #managedBots: ManagedBotStorage;
    readonly #computerId: string | undefined;
    readonly #relay: ComputerManagementGateway;
    readonly #credentialKey: CloudBindings["CHAT_CREDENTIAL_KEY"];

    constructor(cx: {
        readonly config: { readonly bindings: CloudBindings };
        readonly services: { readonly authentication: AuthenticationService };
        readonly storages: {
            readonly managedBots: ManagedBotStorage;
        };
        readonly gateways: { readonly computerManagements: ComputerManagementGateway };
    }) {
        this.#authentication = cx.services.authentication;
        this.#managedBots = cx.storages.managedBots;
        this.#computerId = cx.config.bindings.CHAT_COMPUTER_ID;
        this.#relay = cx.gateways.computerManagements;
        this.#credentialKey = cx.config.bindings.CHAT_CREDENTIAL_KEY;
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
        await this.#provisionUserBot(identity.userId, signal);
        return identity;
    };

    /**
     * Gives the user its Machine unless it already has one. Only identity bootstrap and transfer redemption call this;
     * both are retried writes, so repeating them returns the same Machine.
     */
    readonly #provisionUserBot = async (userId: string, signal: AbortSignal) =>
        await this.#managedBots.claimMachine(userId, Date.now(), signal);

    /** The owner's Machine: where its Runtime pairing stands, read from the Relay that owns it. */
    readonly readMachine = async (userId: string, signal: AbortSignal) => {
        const project = await this.readProject(userId, signal);
        if (project === null) {
            throw new ManagementError("BOT_NOT_FOUND", "Machine is unavailable.", 404);
        }
        return { runtimePairing: await this.#relay.readRuntimePairing(project.computerId, signal) };
    };

    readonly readProject = async (userId: string, signal: AbortSignal) =>
        this.#computerId === undefined || !(await this.#managedBots.hasMachine(userId, signal))
            ? null
            : { computerId: this.#computerId };

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
        const project = await this.#relay.create(
            userId,
            "Morty",
            signal,
            projectRegion(previous.computerId),
            reference,
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
