import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { isIdentifier, runtimeCredentialSuccessor } from "@morty-build/client/protocol";
import { ensurePrivateDirectory } from "../../storage/files/local-files.ts";
import {
    type InstallationDirectory,
    installationDirectory,
    readInstallationFile,
    removeInstallationFile,
    writeInstallationFile,
} from "../../storage/installation/installation-files.ts";
import { tryLock } from "../../storage/installation/local-lock.ts";
import { validateLocalPath } from "../../util/filesystem/private-path.ts";
import {
    type RuntimeConnectionActivation,
    type RuntimeConnectionInput,
    VerifiedRuntimeConnection,
} from "./runtime-connection.ts";
import type { HeldRuntimeCredentials, RuntimeCredentials } from "./runtime-credentials.ts";

const PAIRING_RECORD_VERSION = 8;
const CONNECTION_ID_PATTERN = /^mcn_[a-f0-9]{32}$/;
const RUNTIME_CREDENTIAL_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const VERIFIED_CONNECTION_KEYS: readonly string[] = [
    "activation",
    "computerId",
    "connectionId",
    "defaultWorkspace",
    "kind",
    "relayOrigin",
    "credentials",
    "version",
];

export class RuntimeInstallationStoreError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "RuntimeInstallationStoreError";
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expectedKeys: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function validateConnectionId(value: string): string {
    if (!CONNECTION_ID_PATTERN.test(value)) {
        throw new RuntimeInstallationStoreError("invalid_connection_id", "The local connection ID is invalid");
    }
    return value;
}

function validateIdentifier(value: string, code: string): string {
    if (!isIdentifier(value)) {
        throw new RuntimeInstallationStoreError(code, "The saved Runtime connection is invalid");
    }
    return value;
}

function validateRuntimeCredential(value: string): string {
    if (!RUNTIME_CREDENTIAL_PATTERN.test(value)) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return value;
}

function parseRelayOrigin(value: string): URL {
    let origin: URL;
    try {
        origin = new URL(value);
    } catch (cause) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid", {
            cause,
        });
    }
    if (
        (origin.protocol !== "https:" && origin.protocol !== "http:") ||
        origin.username.length > 0 ||
        origin.password.length > 0 ||
        (origin.protocol === "http:" && origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost")
    ) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    origin.hash = "";
    origin.pathname = "/";
    origin.search = "";
    return origin;
}

function connectionId(): string {
    return `mcn_${randomUUID().replaceAll("-", "")}`;
}

function decodeVerifiedConnection(value: Readonly<Record<string, unknown>>): VerifiedRuntimeConnection {
    if (
        !hasExactKeys(value, VERIFIED_CONNECTION_KEYS) ||
        value["version"] !== PAIRING_RECORD_VERSION ||
        value["kind"] !== "verified"
    ) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    const activation = value["activation"];
    const connectionId = value["connectionId"];
    const defaultWorkspace = value["defaultWorkspace"];
    const computerId = value["computerId"];
    const relayOrigin = value["relayOrigin"];
    const credentials = value["credentials"];
    if (
        (activation !== "active" && activation !== "stopped") ||
        typeof computerId !== "string" ||
        typeof connectionId !== "string" ||
        typeof defaultWorkspace !== "string" ||
        typeof relayOrigin !== "string" ||
        !isRecord(credentials) ||
        !hasExactKeys(credentials, ["current", "successor"]) ||
        typeof credentials["current"] !== "string" ||
        (credentials["successor"] !== null && typeof credentials["successor"] !== "string")
    ) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return new VerifiedRuntimeConnection(
        activation,
        validateConnectionId(connectionId),
        validateIdentifier(computerId, "invalid_connection"),
        defaultWorkspace,
        parseRelayOrigin(relayOrigin),
        {
            current: validateRuntimeCredential(credentials["current"]),
            successor: credentials["successor"] === null ? null : validateRuntimeCredential(credentials["successor"]),
        },
    );
}

function decodeConnection(value: unknown): VerifiedRuntimeConnection {
    if (!isRecord(value)) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return decodeVerifiedConnection(value);
}

async function readJsonFile(path: string, signal: AbortSignal, missingCode: string): Promise<unknown> {
    signal.throwIfAborted();
    const read = await readInstallationFile(path);
    switch (read.kind) {
        case "missing":
            throw new RuntimeInstallationStoreError(missingCode, "The saved Runtime connection was not found", {
                cause: read.cause,
            });
        case "unopenable":
            throw new RuntimeInstallationStoreError(
                "connection_unavailable",
                "The saved Runtime connection cannot be read",
                {
                    cause: read.cause,
                },
            );
        case "not-a-small-file":
            throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
        case "read":
            break;
    }
    signal.throwIfAborted();
    try {
        return JSON.parse(read.text);
    } catch (cause) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid", {
            cause,
        });
    }
}

async function writeJsonAtomically(
    path: string,
    value: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
): Promise<void> {
    try {
        await writeInstallationFile(path, `${JSON.stringify(value, null, 2)}\n`, signal);
    } catch (cause) {
        signal.throwIfAborted();
        throw new RuntimeInstallationStoreError("connection_unavailable", "The local Runtime state cannot be written", {
            cause,
        });
    }
}

export class RuntimeInstallationStore {
    readonly stateDirectory: InstallationDirectory;
    readonly pairingPath: string;

    private constructor(stateDirectory: InstallationDirectory) {
        this.stateDirectory = stateDirectory;
        this.pairingPath = join(stateDirectory, "pairing.json");
    }

    static readonly open = async (engineDataDir: string, signal: AbortSignal): Promise<RuntimeInstallationStore> => {
        signal.throwIfAborted();
        const dataDirectory = resolve(engineDataDir);
        try {
            await ensurePrivateDirectory(dataDirectory);
            await validateLocalPath(dataDirectory, true, true, signal);
        } catch (cause) {
            throw new RuntimeInstallationStoreError(
                "installation_unavailable",
                "The local installation cannot be initialized",
                {
                    cause,
                },
            );
        }
        signal.throwIfAborted();
        return new RuntimeInstallationStore(installationDirectory(dataDirectory));
    };

    private readonly changePairing = async <T>(operation: () => Promise<T>): Promise<T> => {
        const unlock = tryLock(join(this.stateDirectory, "pairing.lock.sqlite"));
        if (!unlock) {
            throw new RuntimeInstallationStoreError("pairing_busy", "Another operation is changing the pairing");
        }
        try {
            return await operation();
        } finally {
            unlock();
        }
    };

    readonly readConnection = async (connectionId: string, signal: AbortSignal): Promise<VerifiedRuntimeConnection> => {
        validateConnectionId(connectionId);
        const connection = decodeConnection(await readJsonFile(this.pairingPath, signal, "connection_not_found"));
        if (connection.connectionId !== connectionId) {
            throw new RuntimeInstallationStoreError(
                "connection_not_found",
                "The requested pairing is no longer selected",
            );
        }
        return connection;
    };

    readonly saveConnection = async (
        input: RuntimeConnectionInput,
        signal: AbortSignal,
    ): Promise<VerifiedRuntimeConnection> => {
        const stored = new VerifiedRuntimeConnection(
            "active",
            connectionId(),
            validateIdentifier(input.computerId, "invalid_connection"),
            input.defaultWorkspace,
            parseRelayOrigin(input.relayOrigin.toString()),
            { current: validateRuntimeCredential(input.runtimeCredential), successor: null },
        );
        await this.changePairing(async () => {
            await this.overwriteConnection(stored, signal);
        });
        return stored;
    };

    readonly currentConnection = async (signal: AbortSignal): Promise<VerifiedRuntimeConnection | null> => {
        try {
            return decodeConnection(await readJsonFile(this.pairingPath, signal, "connection_not_found"));
        } catch (cause) {
            if (cause instanceof RuntimeInstallationStoreError && cause.code === "connection_not_found") {
                return null;
            }
            throw cause;
        }
    };

    readonly listConnections = async (signal: AbortSignal): Promise<readonly VerifiedRuntimeConnection[]> => {
        const current = await this.currentConnection(signal);
        return current === null ? [] : [current];
    };

    readonly setConnectionActivation = async (
        connectionId: string,
        activation: RuntimeConnectionActivation,
        signal: AbortSignal,
    ): Promise<VerifiedRuntimeConnection> => {
        return await this.changePairing(async () => {
            const connection = await this.readConnection(connectionId, signal);
            const updated = new VerifiedRuntimeConnection(
                activation,
                connection.connectionId,
                connection.computerId,
                connection.defaultWorkspace,
                connection.relayOrigin,
                connection.credentials,
            );
            await this.overwriteConnection(updated, signal);
            return updated;
        });
    };

    /**
     * Pairing identity and its rotating credentials commit together. Every writer holds the same process-safe lock
     * and re-reads the selected pairing, so activation cannot restore old credentials and an old Runtime cannot
     * overwrite a replacement. A rejected completion leaves the prepared successor durable for a safe retry.
     */
    readonly runtimeCredentials = (connectionId: string): RuntimeCredentials => ({
        prepare: async (signal) =>
            await this.changePairing(async () => {
                const connection = await this.readConnection(connectionId, signal);
                const saved = connection.credentials;
                const rotation = {
                    current: saved.current,
                    successor: saved.successor ?? runtimeCredentialSuccessor(saved.current),
                };
                if (saved.successor === null) {
                    await this.overwriteCredentials(connection, rotation, signal);
                }
                return rotation;
            }),
        complete: async (rotation, signal) =>
            await this.changePairing(async () => {
                const connection = await this.readConnection(connectionId, signal);
                const saved = connection.credentials;
                if (saved.current === rotation.successor) {
                    return;
                }
                if (saved.current !== rotation.current || saved.successor !== rotation.successor) {
                    throw new RuntimeInstallationStoreError(
                        "credential_conflict",
                        "The saved Runtime credential changed during its rotation",
                    );
                }
                await this.overwriteCredentials(connection, { current: rotation.successor, successor: null }, signal);
            }),
        held: async (signal) => (await this.readConnection(connectionId, signal)).credentials,
    });

    private readonly overwriteCredentials = async (
        connection: VerifiedRuntimeConnection,
        credentials: HeldRuntimeCredentials,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.overwriteConnection(
            new VerifiedRuntimeConnection(
                connection.activation,
                connection.connectionId,
                connection.computerId,
                connection.defaultWorkspace,
                connection.relayOrigin,
                credentials,
            ),
            signal,
        );
    };

    readonly removeConnection = async (connectionId: string, signal: AbortSignal): Promise<void> => {
        await this.changePairing(async () => {
            await this.readConnection(connectionId, signal);
            signal.throwIfAborted();
            await removeInstallationFile(this.pairingPath);
        });
    };

    private readonly overwriteConnection = async (
        connection: VerifiedRuntimeConnection,
        signal: AbortSignal,
    ): Promise<void> => {
        await writeJsonAtomically(
            this.pairingPath,
            {
                activation: connection.activation,
                computerId: connection.computerId,
                connectionId: connection.connectionId,
                defaultWorkspace: connection.defaultWorkspace,
                kind: connection.kind,
                relayOrigin: connection.relayOrigin.toString(),
                credentials: connection.credentials,
                version: PAIRING_RECORD_VERSION,
            },
            signal,
        );
    };
}
