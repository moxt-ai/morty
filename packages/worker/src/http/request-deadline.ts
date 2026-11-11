/** Owns a finite request deadline; completed requests must not keep a Durable Object awake. */
export class RequestDeadline implements Disposable {
    readonly signal: AbortSignal;
    readonly #timer: ReturnType<typeof setTimeout>;

    constructor(parent: AbortSignal, milliseconds: number) {
        parent.throwIfAborted();
        const controller = new AbortController();
        this.#timer = setTimeout(
            () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
            milliseconds,
        );
        this.signal = AbortSignal.any([parent, controller.signal]);
    }

    /** RPC cannot be undone once delivered; cancellation releases the caller without retrying the operation. */
    readonly wait = async <Value>(operation: Promise<Value>): Promise<Value> => {
        this.signal.throwIfAborted();
        const cancelled = Promise.withResolvers<never>();
        const abort = () => cancelled.reject(this.signal.reason);
        this.signal.addEventListener("abort", abort, { once: true });
        try {
            const result = await Promise.race([operation, cancelled.promise]);
            this.signal.throwIfAborted();
            return result;
        } finally {
            this.signal.removeEventListener("abort", abort);
        }
    };

    [Symbol.dispose](): void {
        clearTimeout(this.#timer);
    }
}
