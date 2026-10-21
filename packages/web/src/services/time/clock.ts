export interface Clock {
    readonly now: () => number;
    readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export const systemClock: Clock = {
    now: () => Date.now(),
    sleep: (milliseconds, signal) =>
        new Promise<void>((resolve, reject) => {
            signal.throwIfAborted();
            const abort = () => {
                clearTimeout(timer);
                reject(signal.reason);
            };
            const timer = setTimeout(() => {
                signal.removeEventListener("abort", abort);
                resolve();
            }, milliseconds);
            signal.addEventListener("abort", abort, { once: true });
        }),
};
