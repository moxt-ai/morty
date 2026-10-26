import type { Clock } from "../../src/services/time/clock.ts";

/** A separate application clock: network I/O and Worker authentication keep their own clocks. */
export class TestClock implements Clock {
    #now: number;
    readonly #timers = new Set<{ readonly at: number; readonly resolve: () => void }>();

    constructor(now: string) {
        this.#now = Date.parse(now);
        if (!Number.isFinite(this.#now)) {
            throw new Error("Expected an explicit clock origin");
        }
    }
    readonly now = (): number => this.#now;
    /** How many sleeps are waiting for time to advance. */
    readonly pendingSleeps = (): number => this.#timers.size;
    readonly sleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
        new Promise((resolve, reject) => {
            signal.throwIfAborted();
            const abort = () => {
                this.#timers.delete(timer);
                reject(signal.reason);
            };
            const timer = {
                at: this.#now + milliseconds,
                resolve: () => {
                    signal.removeEventListener("abort", abort);
                    resolve();
                },
            };
            this.#timers.add(timer);
            signal.addEventListener("abort", abort, { once: true });
        });
    readonly advanceBy = (milliseconds: number): void => {
        if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
            throw new Error("Expected a nonnegative clock advance");
        }
        this.#now += milliseconds;
        for (const timer of this.#timers) {
            if (timer.at <= this.#now) {
                this.#timers.delete(timer);
                timer.resolve();
            }
        }
    };
}
