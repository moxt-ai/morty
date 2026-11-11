import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { computerCredentialSuccessor, isIdentifier } from "@morty-build/client/protocol";
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
    type ComputerConnectionActivation,
    type ComputerConnectionInput,
    VerifiedComputerConnection,
} from "./computer-connection.ts";
import type { ComputerCredentials, HeldComputerCredentials } from "./computer-credentials.ts";

const PAIRING_RECORD_VERSION = 9;
const PAIRING_GENERATION_PATTERN = /^mcn_[a-f0-9]{32}$/;
const COMPUTER_CREDENTIAL_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const VERIFIED_CONNECTION_KEYS: readonly string[] = [
    "activation",
    "computerId",
    "pairingGeneration",
    "defaultWorkspace",
    "kind",
    "relayOrigin",
    "credentials",
    "version",
];

export class ComputerInstallationStoreError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "ComputerInstallationStoreError";
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expectedKeys: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function validatePairingGeneration(value: string): string {
    if (!PAIRING_GENERATION_PATTERN.test(value)) {
        throw new ComputerInstallationStoreError("invalid_connection_id", "The local pairing generation is invalid");
    }
    return value;
}

function validateIdentifier(value: string, code: string): string {
    if (!isIdentifier(value)) {
        throw new ComputerInstallationStoreError(code, "The saved Computer connection is invalid");
    }
    return value;
}

function validateComputerCredential(value: string): string {
    if (!COMPUTER_CREDENTIAL_PATTERN.test(value)) {
        throw new ComputerInstallationStoreError("invalid_connection", "The saved Computer connection is invalid");
    }
    return value;
}

function parseRelayOrigin(value: string): URL {
    let origin: URL;
    try {
        origin = new URL(value);
    } catch (cause) {
        throw new ComputerInstallationStoreError("invalid_connection", "The saved Computer connection is invalid", {
            cause,
        });
    }
    if (
        (origin.protocol !== "https:" && origin.protocol !== "http:") ||
        origin.username.length > 0 ||
        origin.password.length > 0 ||
        (origin.protocol === "http:" && origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost")
    ) {
        throw new ComputerInstallationStoreError("invalid_connection", "The saved Computer connection is invalid");
    }
    origin.hash = "";
    origin.pathname = "/";
    origin.search = "";
    return origin;
}

function pairingGeneration(): string {
    return `mcn_${randomUUID().replaceAll("-", "")}`;
}

function decodeVerifiedConnection(value: Readonly<Record<string, unknown>>): VerifiedComputerConnection {
    // Normalize the version-8 field at the storage boundary; all writers use the current representation.
    const generationKey = value["version"] === 8 ? "connectionId" : "pairingGeneration";
    const expectedKeys = VERIFIED_CONNECTION_KEYS.map((key) => (key === "pairingGeneration" ? generationKey : key));
    if (
        !hasExactKeys(value, expectedKeys) ||
        (value["version"] !== 8 && value["version"] !== PAIRING_RECORD_VERSION) ||
        value["kind"] !== "verified"
    ) {
        throw new ComputerInstallationStoreError("invalid_connection", "The saved Computer connection is invalid");
    }
    const activation = value["activation"];
    const pairingGeneration = value[generationKey];
    const defaultWorkspace = value["defaultWorkspace"];
    const computerId = value["computerId"];
    const relayOrigin = value["relayOrigin"];
    const credentials = value["credentials"];
    if (
        (activation !== "active" && activation !== "stopped") ||
        typeof computerId !== "string" ||
        typeof pairingGeneration !== "string" ||
        typeof defaultWorkspace !== "string" ||
        typeof relayOrigin !== "string" ||
        !isRecord(credentials) ||
        !hasExactKeys(credentials, ["current", "successor"]) ||
        typeof credentials["current"] !== "string" ||
        (credentials["successor"] !== null && typeof credentials["successor"] !== "string")
    ) {
        throw new ComputerInstallationStoreError("invalid_connection", "The saved Computer connection is invalid");
    }
    return new VerifiedComputerConnection(
        activation,
        validatePairingGeneration(pairingGeneration),
        validateIdentifier(computerId, "invalid_connection"),
        defaultWorkspace,
        parseRelayOrigin(relayOrigin),
        {
            current: validateComputerCredential(credentials["current"]),
            successor: credentials["successor"] === null ? null : validateComputerCredential(credentials["successor"]),
        },
    );
}

function decodeConnection(value: unknown): VerifiedComputerConnection {
    if (!isRecord(value)) {
        throw new ComputerInstallationStoreError("invalid_connection", "The saved Computer connection is invalid");
    }
    return decodeVerifiedConnection(value);
}

async function readJsonFile(path: string, signal: AbortSignal, missingCode: string): Promise<unknown> {
    signal.throwIfAborted();
    const read = await readInstallationFile(path);
    switch (read.kind) {
        case "missing":
            throw new ComputerInstallationStoreError(missingCode, "The saved Computer connection was not found", {
                cause: read.cause,
            });
        case "unopenable":
            throw new ComputerInstallationStoreError(
                "connection_unavailable",
                "The saved Computer connection cannot be read",
                {
                    cause: read.cause,
                },
            );
        case "not-a-small-file":
            throw new ComputerInstallationStoreError("invalid_connection", "The saved Computer connection is invalid");
        case "read":
            break;
    }
    signal.throwIfAborted();
    try {
        return JSON.parse(read.text);
    } catch (cause) {
        throw new ComputerInstallationStoreError("invalid_connection", "The saved Computer connection is invalid", {
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
        throw new ComputerInstallationStoreError(
            "connection_unavailable",
            "The local Computer state cannot be written",
            {
                cause,
            },
        );
    }
}

export class ComputerInstallationStore {
    readonly stateDirectory: InstallationDirectory;
    readonly pairingPath: string;

    private constructor(stateDirectory: InstallationDirectory) {
        this.stateDirectory = stateDirectory;
        this.pairingPath = join(stateDirectory, "pairing.json");
    }

    static readonly open = async (engineDataDir: string, signal: AbortSignal): Promise<ComputerInstallationStore> => {
        signal.throwIfAborted();
        const dataDirectory = resolve(engineDataDir);
        try {
            await ensurePrivateDirectory(dataDirectory);
            await validateLocalPath(dataDirectory, true, true, signal);
        } catch (cause) {
            throw new ComputerInstallationStoreError(
                "installation_unavailable",
                "The local installation cannot be initialized",
                {
                    cause,
                },
            );
        }
        signal.throwIfAborted();
        return new ComputerInstallationStore(installationDirectory(dataDirectory));
    };

    private readonly changePairing = async <T>(operation: () => Promise<T>): Promise<T> => {
        const unlock = tryLock(join(this.stateDirectory, "pairing.lock.sqlite"));
        if (!unlock) {
            throw new ComputerInstallationStoreError("pairing_busy", "Another operation is changing the pairing");
        }
        try {
            return await operation();
        } finally {
            unlock();
        }
    };

    readonly readConnection = async (
        pairingGeneration: string,
        signal: AbortSignal,
    ): Promise<VerifiedComputerConnection> => {
        validatePairingGeneration(pairingGeneration);
        const connection = decodeConnection(await readJsonFile(this.pairingPath, signal, "connection_not_found"));
        if (connection.pairingGeneration !== pairingGeneration) {
            throw new ComputerInstallationStoreError(
                "connection_not_found",
                "The requested pairing is no longer selected",
            );
        }
        return connection;
    };

    readonly saveConnection = async (
        input: ComputerConnectionInput,
        signal: AbortSignal,
    ): Promise<VerifiedComputerConnection> => {
        const stored = new VerifiedComputerConnection(
            "active",
            pairingGeneration(),
            validateIdentifier(input.computerId, "invalid_connection"),
            input.defaultWorkspace,
            parseRelayOrigin(input.relayOrigin.toString()),
            { current: validateComputerCredential(input.computerCredential), successor: null },
        );
        await this.changePairing(async () => {
            await this.overwriteConnection(stored, signal);
        });
        return stored;
    };

    readonly currentConnection = async (signal: AbortSignal): Promise<VerifiedComputerConnection | null> => {
        try {
            return decodeConnection(await readJsonFile(this.pairingPath, signal, "connection_not_found"));
        } catch (cause) {
            if (cause instanceof ComputerInstallationStoreError && cause.code === "connection_not_found") {
                return null;
            }
            throw cause;
        }
    };

    readonly listConnections = async (signal: AbortSignal): Promise<readonly VerifiedComputerConnection[]> => {
        const current = await this.currentConnection(signal);
        return current === null ? [] : [current];
    };

    readonly setConnectionActivation = async (
        pairingGeneration: string,
        activation: ComputerConnectionActivation,
        signal: AbortSignal,
    ): Promise<VerifiedComputerConnection> => {
        return await this.changePairing(async () => {
            const connection = await this.readConnection(pairingGeneration, signal);
            const updated = new VerifiedComputerConnection(
                activation,
                connection.pairingGeneration,
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
     * and re-reads the selected pairing, so activation cannot restore old credentials and an old Computer cannot
     * overwrite a replacement. A rejected completion leaves the prepared successor durable for a safe retry.
     */
    readonly computerCredentials = (pairingGeneration: string): ComputerCredentials => ({
        prepare: async (signal) =>
            await this.changePairing(async () => {
                const connection = await this.readConnection(pairingGeneration, signal);
                const saved = connection.credentials;
                const rotation = {
                    current: saved.current,
                    successor: saved.successor ?? computerCredentialSuccessor(saved.current),
                };
                if (saved.successor === null) {
                    await this.overwriteCredentials(connection, rotation, signal);
                }
                return rotation;
            }),
        complete: async (rotation, signal) =>
            await this.changePairing(async () => {
                const connection = await this.readConnection(pairingGeneration, signal);
                const saved = connection.credentials;
                if (saved.current === rotation.successor) {
                    return;
                }
                if (saved.current !== rotation.current || saved.successor !== rotation.successor) {
                    throw new ComputerInstallationStoreError(
                        "credential_conflict",
                        "The saved Computer credential changed during its rotation",
                    );
                }
                await this.overwriteCredentials(connection, { current: rotation.successor, successor: null }, signal);
            }),
        held: async (signal) => (await this.readConnection(pairingGeneration, signal)).credentials,
    });

    private readonly overwriteCredentials = async (
        connection: VerifiedComputerConnection,
        credentials: HeldComputerCredentials,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.overwriteConnection(
            new VerifiedComputerConnection(
                connection.activation,
                connection.pairingGeneration,
                connection.computerId,
                connection.defaultWorkspace,
                connection.relayOrigin,
                credentials,
            ),
            signal,
        );
    };

    readonly removeConnection = async (pairingGeneration: string, signal: AbortSignal): Promise<void> => {
        await this.changePairing(async () => {
            await this.readConnection(pairingGeneration, signal);
            signal.throwIfAborted();
            await removeInstallationFile(this.pairingPath);
        });
    };

    private readonly overwriteConnection = async (
        connection: VerifiedComputerConnection,
        signal: AbortSignal,
    ): Promise<void> => {
        await writeJsonAtomically(
            this.pairingPath,
            {
                activation: connection.activation,
                computerId: connection.computerId,
                pairingGeneration: connection.pairingGeneration,
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
