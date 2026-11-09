import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { isIdentifier } from "@morty-build/client/protocol";
import { ensurePrivateDirectory } from "../../storage/files/local-files.ts";
import {
    createInstallationFile,
    type InstallationDirectory,
    installationDirectory,
    installationPointerPath,
    readInstallationFile,
    removeInstallationFile,
    writeInstallationFile,
} from "../../storage/installation/installation-files.ts";
import { tryLock } from "../../storage/installation/local-lock.ts";
import { validateLocalPath } from "../../util/filesystem/private-path.ts";
import { isNodeError } from "../../util/node-error.ts";
import {
    type RuntimeConnectionActivation,
    type RuntimeConnectionInput,
    VerifiedRuntimeConnection,
} from "./runtime-connection.ts";

const CONNECTION_ID_PATTERN = /^mcn_[a-f0-9]{32}$/;
const INSTALLATION_ID_PATTERN = /^min_[a-f0-9]{32}$/;
const RUNTIME_CREDENTIAL_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const INSTALLATION_POINTER_KEYS: readonly string[] = ["installationId", "version"];
const VERIFIED_CONNECTION_KEYS: readonly string[] = [
    "activation",
    "channelId",
    "connectionId",
    "defaultWorkspace",
    "installationId",
    "kind",
    "pairingId",
    "relayOrigin",
    "runtimeCredential",
    "runtimeId",
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

interface InstallationPointer {
    readonly installationId: string;
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

function validateInstallationId(value: string): string {
    if (!INSTALLATION_ID_PATTERN.test(value)) {
        throw new RuntimeInstallationStoreError("invalid_installation_id", "The installation ID is invalid");
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

function installationId(): string {
    return `min_${randomUUID().replaceAll("-", "")}`;
}

function decodeInstallationPointer(value: unknown): InstallationPointer {
    if (!isRecord(value) || !hasExactKeys(value, INSTALLATION_POINTER_KEYS) || value["version"] !== 1) {
        throw new RuntimeInstallationStoreError("invalid_installation", "The local installation record is invalid");
    }
    const storedInstallationId = value["installationId"];
    if (typeof storedInstallationId !== "string") {
        throw new RuntimeInstallationStoreError("invalid_installation", "The local installation record is invalid");
    }
    return { installationId: validateInstallationId(storedInstallationId) };
}

function decodeVerifiedConnection(value: Readonly<Record<string, unknown>>): VerifiedRuntimeConnection {
    if (!hasExactKeys(value, VERIFIED_CONNECTION_KEYS) || value["version"] !== 6 || value["kind"] !== "verified") {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    const activation = value["activation"];
    const channelId = value["channelId"];
    const connectionId = value["connectionId"];
    const defaultWorkspace = value["defaultWorkspace"];
    const storedInstallationId = value["installationId"];
    const pairingId = value["pairingId"];
    const relayOrigin = value["relayOrigin"];
    const runtimeCredential = value["runtimeCredential"];
    const runtimeId = value["runtimeId"];
    if (
        (activation !== "active" && activation !== "stopped") ||
        typeof channelId !== "string" ||
        typeof connectionId !== "string" ||
        typeof defaultWorkspace !== "string" ||
        typeof storedInstallationId !== "string" ||
        typeof pairingId !== "string" ||
        typeof relayOrigin !== "string" ||
        typeof runtimeCredential !== "string" ||
        typeof runtimeId !== "string"
    ) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return new VerifiedRuntimeConnection(
        activation,
        validateInstallationId(storedInstallationId),
        validateConnectionId(connectionId),
        validateIdentifier(channelId, "invalid_connection"),
        defaultWorkspace,
        pairingId.length === 0 ? "" : validateIdentifier(pairingId, "invalid_connection"),
        parseRelayOrigin(relayOrigin),
        validateRuntimeCredential(runtimeCredential),
        validateIdentifier(runtimeId, "invalid_connection"),
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
    readonly installationId: string;
    readonly stateDirectory: InstallationDirectory;
    readonly pairingPath: string;

    private constructor(installationId: string, stateDirectory: InstallationDirectory) {
        this.installationId = installationId;
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
        const storedInstallationId = await readOrCreateInstallationId(dataDirectory, signal);
        const stateDirectory = installationDirectory(dataDirectory, storedInstallationId);
        try {
            await ensurePrivateDirectory(stateDirectory);
            await validateLocalPath(stateDirectory, true, true, signal);
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
        return new RuntimeInstallationStore(storedInstallationId, stateDirectory);
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
        const connection = this.decodeOwnedConnection(
            await readJsonFile(this.pairingPath, signal, "connection_not_found"),
        );
        if (connection.connectionId !== connectionId) {
            throw new RuntimeInstallationStoreError(
                "connection_not_found",
                "The requested pairing is no longer selected",
            );
        }
        return connection;
    };

    private readonly decodeOwnedConnection = (record: unknown): VerifiedRuntimeConnection => {
        const stored = decodeConnection(record);
        if (stored.installationId !== this.installationId) {
            throw new RuntimeInstallationStoreError(
                "connection_owner_mismatch",
                "The saved Runtime connection belongs to another installation",
            );
        }
        return stored;
    };

    readonly saveConnection = async (
        input: RuntimeConnectionInput,
        signal: AbortSignal,
    ): Promise<VerifiedRuntimeConnection> => {
        const stored = new VerifiedRuntimeConnection(
            "active",
            this.installationId,
            connectionId(),
            validateIdentifier(input.channelId, "invalid_connection"),
            input.defaultWorkspace,
            input.pairingId.length === 0 ? "" : validateIdentifier(input.pairingId, "invalid_pairing_id"),
            parseRelayOrigin(input.relayOrigin.toString()),
            validateRuntimeCredential(input.runtimeCredential),
            validateIdentifier(input.runtimeId, "invalid_connection"),
        );
        await this.changePairing(() => this.overwriteConnection(stored, signal));
        return stored;
    };

    readonly currentConnection = async (signal: AbortSignal): Promise<VerifiedRuntimeConnection | null> => {
        try {
            return this.decodeOwnedConnection(await readJsonFile(this.pairingPath, signal, "connection_not_found"));
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

    readonly readConnectionForPairing = async (
        pairingId: string,
        signal: AbortSignal,
    ): Promise<VerifiedRuntimeConnection | null> => {
        const normalizedPairingId = validateIdentifier(pairingId, "invalid_pairing_id");
        const connections = await this.listConnections(signal);
        return connections.find((connection) => connection.pairingId === normalizedPairingId) ?? null;
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
                connection.installationId,
                connection.connectionId,
                connection.channelId,
                connection.defaultWorkspace,
                connection.pairingId,
                connection.relayOrigin,
                connection.runtimeCredential,
                connection.runtimeId,
            );
            await this.overwriteConnection(updated, signal);
            return updated;
        });
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
                channelId: connection.channelId,
                connectionId: connection.connectionId,
                defaultWorkspace: connection.defaultWorkspace,
                installationId: connection.installationId,
                kind: connection.kind,
                pairingId: connection.pairingId,
                relayOrigin: connection.relayOrigin.toString(),
                runtimeCredential: connection.runtimeCredential,
                runtimeId: connection.runtimeId,
                version: 6,
            },
            signal,
        );
    };
}

async function readOrCreateInstallationId(engineDataDir: string, signal: AbortSignal): Promise<string> {
    const pointerPath = installationPointerPath(engineDataDir);
    try {
        return decodeInstallationPointer(await readJsonFile(pointerPath, signal, "installation_not_found"))
            .installationId;
    } catch (cause) {
        if (!(cause instanceof RuntimeInstallationStoreError) || cause.code !== "installation_not_found") {
            throw cause;
        }
    }

    const candidate = installationId();
    try {
        await createInstallationFile(pointerPath, `${JSON.stringify({ installationId: candidate, version: 1 })}\n`);
        return candidate;
    } catch (cause) {
        if (!isNodeError(cause, "EEXIST")) {
            throw new RuntimeInstallationStoreError(
                "installation_unavailable",
                "The local installation cannot be initialized",
                {
                    cause,
                },
            );
        }
        return decodeInstallationPointer(await readJsonFile(pointerPath, signal, "installation_not_found"))
            .installationId;
    }
}
