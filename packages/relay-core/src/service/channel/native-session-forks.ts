import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import { sameNativeSession } from "@morty-build/client/native-session";
import {
    decodeNativeSessionRequest,
    decodeNativeSessionResult,
    decodeSessionCreationReadCommand,
    decodeSessionQueryCommand,
    RUNTIME_WORKSPACE_BINDING_ID,
} from "@morty-build/client/protocol";
import { type ComputerScope, RuntimeOperationFailedError } from "../../entity/do/session.ts";
import { hashSecret, PairingDirectoryError } from "../../entity/pairing/pairing.ts";
import type { SessionRuntimeOperations } from "../../gateway/session-runtime-operations.ts";
import type { NativeSessionForkStorage } from "../../storage/native-session-fork-storage.ts";

function forkResult(value: string) {
    const result = decodeNativeSessionResult(value);
    if (result.action !== "fork" || !sameNativeSession(result.ready.target, result.target)) {
        throw new PairingDirectoryError("invalid_native_session_response", "The Runtime returned an invalid Fork");
    }
    return result;
}

function sourceResult(value: unknown) {
    const source = decodeNativeSessionResult(JSON.stringify(value));
    if (source.action !== "find") {
        throw new PairingDirectoryError("invalid_native_session_response", "The Fork source is invalid");
    }
    return source;
}

function forkReceipt(value: string) {
    const encoded: unknown = JSON.parse(value);
    if (typeof encoded !== "object" || encoded === null || !("source" in encoded) || !("result" in encoded)) {
        throw new PairingDirectoryError("invalid_native_session_response", "The Fork receipt is invalid");
    }
    return { source: sourceResult(encoded.source), result: forkResult(JSON.stringify(encoded.result)) };
}

function unknownOutcome(cause?: unknown): PairingDirectoryError {
    return new PairingDirectoryError(
        "native_fork_outcome_unknown",
        "The Fork outcome is unknown. Check local sessions before starting another Fork.",
        { cause },
    );
}

async function waitForFork<T>(completion: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void completion.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}

/** A Fork operation retains the harness's returned pair, never an assigned destination. */
export class NativeSessionForks {
    readonly #storage: NativeSessionForkStorage;
    readonly #waitUntil: (operation: Promise<void>) => void;
    readonly #running = new Map<
        string,
        {
            readonly requestHash: string;
            readonly completion: Promise<ReturnType<typeof forkReceipt>>;
        }
    >();

    constructor(storage: NativeSessionForkStorage, waitUntil: (operation: Promise<void>) => void) {
        this.#storage = storage;
        this.#waitUntil = waitUntil;
    }

    readonly fork = async (
        scope: ComputerScope,
        operationId: string,
        input: ForkMortyNativeSessionRequest,
        request: SessionRuntimeOperations["requestComputerScopeControl"],
        signal: AbortSignal,
    ) => {
        const requestHash = await hashSecret(
            JSON.stringify([input.agentId, input.sessionId, input.directoryId, input.additionalDirectoryIds]),
        );
        signal.throwIfAborted();
        const key = JSON.stringify([scope.computerId, operationId]);
        const prior = this.#storage.read(scope.computerId, operationId);
        const running = this.#running.get(key);
        if (
            (prior !== undefined && prior.requestHash !== requestHash) ||
            (running !== undefined && running.requestHash !== requestHash)
        ) {
            throw new PairingDirectoryError("idempotency_conflict", "This Fork operation has different inputs");
        }
        if (prior?.resultJson != null) {
            return forkReceipt(prior.resultJson);
        }
        if (running !== undefined) {
            return await waitForFork(running.completion, signal);
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException("Fork timed out", "TimeoutError")), 120_000);
        const completion = Promise.resolve().then(async () => {
            try {
                if (prior !== undefined) {
                    if (prior.attemptJson === null) {
                        throw unknownOutcome();
                    }
                    const source = sourceResult(JSON.parse(prior.attemptJson));
                    // A completed local receipt survives Relay response loss and daemon restarts.
                    const ready = await request(
                        scope,

                        decodeSessionCreationReadCommand(
                            JSON.stringify({
                                kind: "session.creation.read",
                                requestId: crypto.randomUUID(),
                                operationId,
                            }),
                        ),
                        controller.signal,
                    );
                    if (
                        ready.kind !== "session.ready" ||
                        ready.target.harness !== input.agentId ||
                        ready.target.sessionId === input.sessionId ||
                        ready.directoryId !== source.entry.directoryId ||
                        JSON.stringify(ready.additionalDirectories.map((directory) => directory.directoryId)) !==
                            JSON.stringify(source.entry.additionalDirectories.map((directory) => directory.directoryId))
                    ) {
                        throw unknownOutcome();
                    }
                    const queried = await request(
                        scope,

                        decodeSessionQueryCommand(
                            JSON.stringify({
                                kind: "session.query",
                                requestId: crypto.randomUUID(),
                                targets: [ready.target],
                            }),
                        ),
                        controller.signal,
                    );
                    const entry =
                        queried.kind === "session.queried"
                            ? queried.entries.find((entry) => sameNativeSession(entry.target, ready.target))
                            : undefined;
                    if (entry === undefined) {
                        throw unknownOutcome();
                    }
                    const result = forkResult(
                        JSON.stringify({
                            kind: "native.session.result",
                            action: "fork",
                            requestId: operationId,
                            discoveryId: source.discoveryId,
                            target: ready.target,
                            ready,
                            title: entry.title,
                        }),
                    );
                    const receipt = { source, result };
                    this.#storage.complete(scope.computerId, operationId, JSON.stringify(receipt));
                    return receipt;
                }
                const found = await request(
                    scope,
                    decodeNativeSessionRequest(
                        JSON.stringify({
                            ...input,
                            action: "find",
                            kind: "native.session.request",
                            bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                            requestId: crypto.randomUUID(),
                            discoveryId: crypto.randomUUID(),
                        }),
                    ),
                    controller.signal,
                );
                if (
                    found.kind !== "native.session.result" ||
                    found.action !== "find" ||
                    found.entry.sessionId !== input.sessionId
                ) {
                    throw new PairingDirectoryError(
                        "invalid_native_session_response",
                        "The native session could not be found",
                    );
                }
                controller.signal.throwIfAborted();
                const command = decodeNativeSessionRequest(
                    JSON.stringify({
                        kind: "native.session.request",
                        action: "fork",
                        agentId: input.agentId,
                        bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                        directoryId: found.entry.directoryId,
                        additionalDirectoryIds: found.entry.additionalDirectories.map(
                            (directory) => directory.directoryId,
                        ),
                        requestId: operationId,
                        discoveryId: found.discoveryId,
                        entryId: found.entry.entryId,
                    }),
                );
                this.#storage.start(scope.computerId, operationId, requestHash, JSON.stringify(found));
                const result = forkResult(JSON.stringify(await request(scope, command, controller.signal)));
                if (result.target.harness !== input.agentId || result.target.sessionId === input.sessionId) {
                    throw new PairingDirectoryError("invalid_native_session_response", "The Fork target is invalid");
                }
                const receipt = { source: found, result };
                this.#storage.complete(scope.computerId, operationId, JSON.stringify(receipt));
                return receipt;
            } catch (cause) {
                if (controller.signal.aborted) {
                    throw controller.signal.reason;
                }
                // This refusal is returned before the daemon admits a harness fork. It is safe to retry the same
                // operation later; transport failures and post-admission errors retain the unknown-outcome receipt.
                if (
                    prior === undefined &&
                    cause instanceof RuntimeOperationFailedError &&
                    cause.code === "native_session_unsupported"
                ) {
                    this.#storage.abandon(scope.computerId, operationId);
                    throw cause;
                }
                if (this.#storage.read(scope.computerId, operationId) === undefined) {
                    throw cause;
                }
                throw unknownOutcome(cause);
            } finally {
                clearTimeout(timer);
                this.#running.delete(key);
            }
        });
        this.#running.set(key, { requestHash, completion });
        this.#waitUntil(
            completion.then(
                () => undefined,
                () => undefined,
            ),
        );
        return await waitForFork(completion, signal);
    };
}
