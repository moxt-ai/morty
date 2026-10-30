import type { Clock } from "../../services/time/clock.ts";

// Resuming a suspended browser can consume a full health check and socket handshake
// before Session reconciliation completes. Give that automatic recovery time to finish.
const RECOVERY_NOTICE_DELAY_MS = 30_000;

/** One interruption's notice: only uninterrupted foreground recovery time can make it visible. */
export function startRecoveryNotice(options: {
    readonly clock: Clock;
    readonly signal: AbortSignal;
    readonly onNotice: (notice: "quiet" | "visible") => void;
}): AbortController {
    options.signal.throwIfAborted();
    const lifetime = new AbortController();
    let deadline: AbortController | null = null;
    const pause = (): void => {
        deadline?.abort();
        deadline = null;
        options.onNotice("quiet");
    };
    const resume = (): void => {
        if (lifetime.signal.aborted || document.visibilityState === "hidden" || deadline !== null) {
            return;
        }
        const attempt = new AbortController();
        deadline = attempt;
        const signal = AbortSignal.any([lifetime.signal, attempt.signal]);
        void options.clock.sleep(RECOVERY_NOTICE_DELAY_MS, signal).then(
            () => {
                if (!signal.aborted) {
                    options.onNotice("visible");
                }
            },
            () => undefined,
        );
    };
    const visibilityChanged = (): void => {
        if (document.visibilityState === "hidden") {
            pause();
        } else {
            resume();
        }
    };
    lifetime.signal.addEventListener("abort", () => deadline?.abort(), { once: true });
    options.signal.addEventListener("abort", () => lifetime.abort(), { once: true, signal: lifetime.signal });
    const listener = { signal: lifetime.signal };
    document.addEventListener("visibilitychange", visibilityChanged, listener);
    document.addEventListener("freeze", pause, listener);
    document.addEventListener("resume", resume, listener);
    window.addEventListener("pagehide", pause, listener);
    window.addEventListener("pageshow", resume, listener);
    visibilityChanged();
    return lifetime;
}
