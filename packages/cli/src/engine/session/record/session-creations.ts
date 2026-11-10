import { createHash } from "node:crypto";
import { decodeSessionReadyEvent, type SessionReadyEvent } from "@morty-build/client/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import type { SessionCreationTable } from "../../storage/session/session-creation-table.ts";

/** Durable operation identity survives response loss without inventing a Session identity. */
export class SessionCreations {
    readonly #table: SessionCreationTable;
    readonly #running = new Map<string, { readonly hash: string; readonly result: Promise<SessionReadyEvent> }>();

    constructor(table: SessionCreationTable) {
        this.#table = table;
    }

    readonly read = (operationId: string): SessionReadyEvent => {
        const prior = this.#table.read(operationId);
        if (prior === undefined || prior.resultJson === null) {
            throw new AcpExecutionError(
                "No completed creation receipt is available",
                {},
                "session_creation_unavailable",
            );
        }
        return decodeSessionReadyEvent(prior.resultJson);
    };

    readonly settle = async (): Promise<void> => {
        await Promise.allSettled([...this.#running.values()].map(({ result }) => result));
    };

    /** A completed operation can be recovered without revalidating its former execution environment. */
    readonly recover = (
        operationId: string,
        input: unknown,
        signal: AbortSignal,
    ): Promise<SessionReadyEvent> | null => {
        signal.throwIfAborted();
        const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        const prior = this.#table.read(operationId);
        const running = this.#running.get(operationId);
        if ((prior !== undefined && prior.requestHash !== hash) || (running !== undefined && running.hash !== hash)) {
            throw new AcpExecutionError("The creation operation has different inputs", {}, "idempotency_conflict");
        }
        if (running !== undefined) {
            return this.#wait(running.result, signal);
        }
        if (prior !== undefined) {
            if (prior.resultJson === null) {
                throw new AcpExecutionError(
                    "Session creation may have completed. Check local sessions before starting another conversation.",
                    {},
                    "session_creation_outcome_unknown",
                );
            }
            return Promise.resolve(decodeSessionReadyEvent(prior.resultJson));
        }
        return null;
    };

    readonly run = async (
        operationId: string,
        input: unknown,
        signal: AbortSignal,
        create: () => Promise<SessionReadyEvent>,
    ): Promise<SessionReadyEvent> => {
        const recovered = this.recover(operationId, input, signal);
        if (recovered !== null) {
            return await recovered;
        }
        const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        this.#table.start(operationId, hash);
        const result = Promise.resolve().then(async () => {
            try {
                const ready = await create();
                this.#table.complete(operationId, JSON.stringify(ready));
                return ready;
            } catch (cause) {
                // Definite pre-admission refusals can repeat; generic Agent errors and transport loss cannot.
                if (
                    !signal.aborted &&
                    cause instanceof AcpExecutionError &&
                    (cause.code === "session_configuration_conflict" || cause.code === "session_creation_refused")
                ) {
                    this.#table.remove(operationId);
                }
                throw cause;
            } finally {
                this.#running.delete(operationId);
            }
        });
        this.#running.set(operationId, { hash, result });
        return await this.#wait(result, signal);
    };

    async #wait(result: Promise<SessionReadyEvent>, signal: AbortSignal): Promise<SessionReadyEvent> {
        signal.throwIfAborted();
        return await new Promise((resolve, reject) => {
            const aborted = () => reject(signal.reason);
            signal.addEventListener("abort", aborted, { once: true });
            void result.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
        });
    }
}
