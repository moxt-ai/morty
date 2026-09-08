/** Serializes operations while allowing callers to cancel their wait. */
export class SerialExecutor {
    #tail: Promise<void> = Promise.resolve();

    readonly run = async <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
        signal.throwIfAborted();
        const previous = this.#tail;
        const turn = Promise.withResolvers<void>();
        this.#tail = previous.then(() => turn.promise);
        const cancelled = Promise.withResolvers<never>();
        const abort = () => cancelled.reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        try {
            await Promise.race([previous, cancelled.promise]);
            signal.throwIfAborted();
            return await operation();
        } finally {
            signal.removeEventListener("abort", abort);
            turn.resolve();
        }
    };
}
