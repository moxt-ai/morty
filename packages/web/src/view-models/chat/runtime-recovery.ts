import type { Clock } from "../../services/time/clock.ts";

/**
 * How the page saw a Runtime configuration: read directly by a load, or delivered by a configuration watch. A watch
 * snapshot follows a change when the Runtime changed since the previous one, or may have while the bridge was down.
 */
export type RuntimeObservation = { readonly kind: "read" } | { readonly kind: "watch"; readonly afterChange: boolean };

/**
 * How long to wait before each retry of what still waits for a Runtime the page sees online. A Runtime reported online
 * may not serve yet, so retries continue with growing delays; once they are used up, the next change starts over.
 */
const RECOVERY_DELAYS_MS = [0, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const;

/**
 * Retries what the workspace reads through the Runtime and could not read while the Runtime was unreachable, the way
 * Reconnect would, while the page sees the Runtime online. A return the page observes retries at once; a retry that
 * fails again, or something that only starts waiting later, is retried after a growing delay. Seeing the Runtime
 * offline, or a change, starts the delays over, and nothing is retried while nothing waits.
 */
export function createRuntimeRecovery(options: {
    readonly clock: Clock;
    readonly lifetime: AbortSignal;
    /** Whether anything still waits for the Runtime. */
    readonly waiting: () => boolean;
    /** Retries everything that waits. */
    readonly retry: () => void;
}) {
    let online = false;
    let attempts = 0;
    let scheduled: AbortController | null = null;
    const cancelScheduled = (): void => {
        scheduled?.abort(new DOMException("The Runtime recovery was rescheduled", "AbortError"));
        scheduled = null;
    };
    const retry = (): void => {
        attempts += 1;
        options.retry();
    };
    const schedule = (): void => {
        if (scheduled !== null || !online || options.lifetime.aborted) {
            return;
        }
        if (!options.waiting()) {
            attempts = 0;
            return;
        }
        const delay = RECOVERY_DELAYS_MS[attempts];
        if (delay === undefined) {
            return;
        }
        if (delay === 0) {
            retry();
            return;
        }
        const controller = new AbortController();
        scheduled = controller;
        void options.clock.sleep(delay, AbortSignal.any([options.lifetime, controller.signal])).then(
            () => {
                scheduled = null;
                if (online && options.waiting()) {
                    retry();
                }
            },
            () => undefined,
        );
    };
    return {
        /** Adopts a Runtime configuration the page observed. */
        observe: (configurationOnline: boolean, observation: RuntimeObservation): void => {
            if (!configurationOnline || (observation.kind === "watch" && observation.afterChange)) {
                attempts = 0;
                cancelScheduled();
            }
            online = configurationOnline;
            // A load reads the configuration before it reads through the Runtime, so nothing it reads waits yet.
            if (observation.kind === "watch") {
                schedule();
            }
        },
        /**
         * Something read through the Runtime finished, failed or stopped following it. What failed on its own waits
         * before its first retry; only an observed return retries at once.
         */
        settled: (): void => {
            attempts = Math.max(attempts, 1);
            schedule();
        },
    };
}
