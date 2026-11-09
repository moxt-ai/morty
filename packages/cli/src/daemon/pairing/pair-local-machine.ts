import { join } from "node:path";
import { claimMortyState } from "@morty-build/local-state";
import type { VerifiedRuntimeConnection } from "../../engine/runtime/connection/runtime-connection.ts";
import {
    RuntimeInstallationStore,
    RuntimeInstallationStoreError,
} from "../../engine/runtime/connection/runtime-installation-store.ts";
import {
    PairingClientError,
    pairRuntimeConnection,
    parsePairingCode,
    parseRelayOrigin,
    prepareRuntimeConnection,
    validatePairingId,
} from "../../engine/runtime/pairing.ts";
import { ensurePrivateDirectory } from "../../engine/storage/files/local-files.ts";
import { validateLocalPath } from "../../engine/util/filesystem/private-path.ts";
import { readStateDirectory } from "../../storage/state-directory.ts";
import { resolveMaxAcpProcesses } from "../config.ts";

function readSingleOption(arguments_: readonly string[], option: string): string {
    const values: string[] = [];
    for (let index = 0; index < arguments_.length; index += 1) {
        if (arguments_[index] !== option) {
            continue;
        }
        const value = arguments_[index + 1];
        if (value === undefined || value.startsWith("--")) {
            throw new PairingClientError("invalid_arguments", `${option} requires a value`);
        }
        values.push(value);
        index += 1;
    }
    if (values.length !== 1) {
        throw new PairingClientError("invalid_arguments", `${option} must be provided exactly once`);
    }
    return values[0] ?? "";
}

function parsePairCommand(arguments_: readonly string[], defaultWorkspace: string) {
    for (let index = 0; index < arguments_.length; index += 2) {
        const option = arguments_[index];
        if (option !== "--url" && option !== "--code" && option !== "--pairing" && option !== "--workspace") {
            throw new PairingClientError("invalid_arguments", `Unknown pairing option: ${option ?? "missing option"}`);
        }
    }
    return {
        code: parsePairingCode(readSingleOption(arguments_, "--code")),
        pairingId: arguments_.includes("--pairing") ? validatePairingId(readSingleOption(arguments_, "--pairing")) : "",
        relayOrigin: parseRelayOrigin(readSingleOption(arguments_, "--url")),
        workspace: arguments_.includes("--workspace") ? readSingleOption(arguments_, "--workspace") : defaultWorkspace,
    };
}

export async function openMortyInstallation(
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<RuntimeInstallationStore> {
    const root = readStateDirectory(environment);
    try {
        await claimMortyState(root, signal);
        await ensurePrivateDirectory(root);
        await validateLocalPath(root, true, true, signal);
    } catch (cause) {
        signal.throwIfAborted();
        throw new RuntimeInstallationStoreError(
            "installation_unavailable",
            "The local installation cannot be initialized",
            { cause },
        );
    }
    return await RuntimeInstallationStore.open(join(root, "machine"), signal);
}

export async function pairLocalMachine(
    arguments_: readonly string[],
    signal: AbortSignal = new AbortController().signal,
): Promise<VerifiedRuntimeConnection> {
    const requested = parsePairCommand(arguments_, "");
    const installation = await openMortyInstallation(signal, process.env);
    if (requested.pairingId.length > 0) {
        const existing = await installation.readConnectionForPairing(requested.pairingId, signal);
        if (existing !== null && existing.relayOrigin.origin === requested.relayOrigin.origin) {
            await prepareRuntimeConnection(
                installation,
                existing,
                signal,
                process.env,
                resolveMaxAcpProcesses(process.env),
            );
            return existing;
        }
    }
    return await pairRuntimeConnection(
        installation,
        {
            pairingCode: requested.code,
            pairingId: requested.pairingId,
            relayOrigin: requested.relayOrigin.toString(),
            defaultWorkspace: arguments_.includes("--workspace")
                ? requested.workspace
                : join(readStateDirectory(), "workspace"),
        },
        signal,
        process.env,
    );
}
