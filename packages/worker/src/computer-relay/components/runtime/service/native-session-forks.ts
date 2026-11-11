import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import { sameNativeSession } from "@morty-build/client/native-session";
import { decodeNativeSessionRequest, type NativeSessionResult } from "@morty-build/client/protocol";
import { PairingDirectoryError } from "../../../../contracts/relay/pairing.ts";
import type { ComputerControlCommand, ComputerControlResult } from "./computer-control-request.ts";

async function waitForFork<T>(completion: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void completion.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}

/**
 * Forwards a Fork to the Computer under its operation identity. The Computer keeps the Fork's receipt under that identity,
 * so a retry after an ambiguous failure answers with the original Fork, and reusing it with other inputs is refused.
 * The Relay keeps no receipt; it only joins concurrent requests for one operation into one Computer request, since the
 * Computer refuses a second request under an identity it is still answering.
 */
export class NativeSessionForks {
    readonly #waitUntil: (operation: Promise<void>) => void;
    readonly #running = new Map<
        string,
        {
            readonly input: string;
            readonly completion: Promise<NativeSessionResult>;
        }
    >();

    constructor(waitUntil: (operation: Promise<void>) => void) {
        this.#waitUntil = waitUntil;
    }

    readonly fork = async (
        computerId: string,
        operationId: string,
        input: ForkMortyNativeSessionRequest,
        request: (
            computerId: string,
            command: ComputerControlCommand,
            signal: AbortSignal,
        ) => Promise<ComputerControlResult>,
        signal: AbortSignal,
    ): Promise<NativeSessionResult> => {
        signal.throwIfAborted();
        const key = JSON.stringify([computerId, operationId]);
        const requested = JSON.stringify([input.harness, input.sessionId, input.directory]);
        const running = this.#running.get(key);
        if (running !== undefined) {
            if (running.input !== requested) {
                throw new PairingDirectoryError("idempotency_conflict", "This Fork operation has different inputs");
            }
            return await waitForFork(running.completion, signal);
        }
        // Every request joined to this Fork waits on it, so one caller leaving does not cancel it for the others.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException("Fork timed out", "TimeoutError")), 120_000);
        const completion = Promise.resolve().then(async (): Promise<NativeSessionResult> => {
            try {
                const result = await request(
                    computerId,
                    decodeNativeSessionRequest(
                        JSON.stringify({
                            kind: "native.session.request",
                            action: "fork",
                            harness: input.harness,
                            directory: input.directory,
                            requestId: operationId,
                            sessionId: input.sessionId,
                        }),
                    ),
                    controller.signal,
                );
                if (
                    result.kind !== "native.session.result" ||
                    result.action !== "fork" ||
                    !sameNativeSession(result.ready.target, result.target) ||
                    result.target.harness !== input.harness ||
                    result.target.sessionId === input.sessionId
                ) {
                    throw new PairingDirectoryError(
                        "invalid_native_session_response",
                        "The Computer returned an invalid Fork",
                    );
                }
                return result;
            } finally {
                clearTimeout(timer);
                this.#running.delete(key);
            }
        });
        this.#running.set(key, { input: requested, completion });
        this.#waitUntil(
            completion.then(
                () => undefined,
                () => undefined,
            ),
        );
        return await waitForFork(completion, signal);
    };
}
