import type { Clock } from "../../services/time/clock.ts";

/**
 * How the page saw a Runtime configuration: read directly by a load, or delivered by a configuration watch. A watch
 * snapshot follows a change when the Runtime changed since the previous one, or may have while the bridge was down.
 */
export type RuntimeObservation = { readonly kind: "read" } | { readonly kind: "watch"; readonly afterChange: boolean };

/**
 * How long to wait before each retry of what failed while the page sees the Runtime online. A Runtime reported online
 * may not serve yet, so retries continue with growing delays; once they are used up, the next change starts over.
 */
const RECOVERY_DELAYS_MS = [0, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const;
/** A failure after the readers have worked this long is a new outage, which starts the delays over. */
const RECOVERY_STABLE_MS = 60_000;

/**
 * Retries what the workspace reads through the Runtime and could not read while the Runtime was unreachable, the way
 * Reconnect would, while the page sees the Runtime online.
 *
 * A return the page observes retries at once. Otherwise a retry follows only a reported failure, after a delay that
 * grows with each failure of the same outage, so a retry still in flight is never restarted, and a Runtime reported
 * online that cannot serve is not retried in a loop. Seeing the Runtime offline, a change, or a failure after the
 * readers worked for a while starts the delays over; time spent failing never counts as working. `waiting` is derived
 * from what the readers hold: something that is loading or following again is in flight, not waiting.
 */
export function createRuntimeRecovery(options: {
    readonly clock: Clock;
    readonly lifetime: AbortSignal;
    /** Whether anything failed for the Runtime and is not being retried now. */
    readonly waiting: () => boolean;
    /** Retries everything that waits. */
    readonly retry: () => void;
}) {
    let online = false;
    let attempts = 0;
    // When a reader last showed it works again, cleared by the next failure.
    let workingSince: number | null = null;
    let scheduled: AbortController | null = null;
    const startOver = (): void => {
        attempts = 0;
        scheduled?.abort(new DOMException("The Runtime recovery started over", "AbortError"));
        scheduled = null;
    };
    const retry = (): void => {
        if (!online || options.lifetime.aborted || !options.waiting()) {
            return;
        }
        attempts += 1;
        options.retry();
    };
    const schedule = (): void => {
        if (scheduled !== null || !online || options.lifetime.aborted || !options.waiting()) {
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
                if (scheduled === controller) {
                    scheduled = null;
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
                startOver();
            }
            online = configurationOnline;
            // A load reads the configuration before it reads through the Runtime, so nothing it reads waits yet.
            if (observation.kind === "watch") {
                schedule();
            }
        },
        /** Something read through the Runtime works again: a session opened, a list loaded, or statuses are followed. */
        working: (): void => {
            workingSince ??= options.clock.now();
        },
        /** Something read through the Runtime failed for it: the home view, a list load, or the status stream. */
        failed: (): void => {
            if (workingSince !== null && options.clock.now() - workingSince >= RECOVERY_STABLE_MS) {
                startOver();
            }
            workingSince = null;
            // What failed on its own waits before its retry; only an observed return retries at once.
            attempts = Math.max(attempts, 1);
            schedule();
        },
    };
}
