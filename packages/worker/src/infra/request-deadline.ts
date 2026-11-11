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

    [Symbol.dispose](): void {
        clearTimeout(this.#timer);
    }
}
