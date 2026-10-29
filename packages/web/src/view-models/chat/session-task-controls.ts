import { createStore } from "zustand/vanilla";
import type { Clock } from "../../services/time/clock.ts";
import { formatError } from "../format-error.ts";

/** The turn the service reports running, as the Session pane's current turn holds it. */
export interface RunningTurn {
    readonly commandId: string;
    readonly turnId: string;
}

type TaskControlFeedback =
    | { readonly kind: "none" }
    | { readonly kind: "failed"; readonly commandId: string; readonly message: string };

interface TaskControlPort {
    readonly cancel: (turnId: string, signal: AbortSignal) => Promise<void>;
}

/**
 * The stop control. Which turn runs belongs to the pane's current turn; this store keeps only what the user asked of
 * it: a stop request for a command, and why the last request failed.
 */
export interface SessionTaskControlsStore {
    readonly feedback: TaskControlFeedback;
    /** The command the user asked to stop, while that request is in flight or until its turn ends. */
    readonly stopRequest: { readonly commandId: string } | null;
    readonly steeringSupported: boolean;
    readonly dismissFailure: () => void;
    /** A different turn or confirmed idle state retires the previous command's stop feedback. */
    readonly turnChanged: (commandId: string | null) => void;
    readonly stop: (signal: AbortSignal) => Promise<void>;
}

/** Whether the user's stop request applies to the running turn. */
export function stopRequested(
    tasks: Pick<SessionTaskControlsStore, "stopRequest">,
    running: RunningTurn | null,
): boolean {
    return running !== null && tasks.stopRequest?.commandId === running.commandId;
}

/** The stop control's failure while the targeted turn still runs. */
export function stopFailure(tasks: Pick<SessionTaskControlsStore, "feedback">): string | null {
    return tasks.feedback.kind === "failed" ? tasks.feedback.message : null;
}

export const createSessionTaskControlsStore = (options: {
    readonly clock: Clock;
    readonly port: TaskControlPort;
    readonly steeringSupported: boolean;
    readonly runningTurn: () => RunningTurn | null;
}) =>
    createStore<SessionTaskControlsStore>()((set, get) => ({
        feedback: { kind: "none" },
        stopRequest: null,
        steeringSupported: options.steeringSupported,
        dismissFailure: () => set({ feedback: { kind: "none" } }),
        turnChanged: (commandId) => {
            const { feedback, stopRequest } = get();
            const staleFeedback = feedback.kind === "failed" && feedback.commandId !== commandId;
            const staleRequest = stopRequest !== null && stopRequest.commandId !== commandId;
            if (staleFeedback || staleRequest) {
                set({
                    ...(staleFeedback ? { feedback: { kind: "none" as const } } : {}),
                    ...(staleRequest ? { stopRequest: null } : {}),
                });
            }
        },
        stop: async (parent) => {
            const running = options.runningTurn();
            if (running === null || stopRequested(get(), running)) {
                return;
            }
            const request = { commandId: running.commandId };
            const deadline = new AbortController();
            const signal = AbortSignal.any([parent, deadline.signal]);
            void options.clock.sleep(15_000, signal).then(
                () => deadline.abort(new DOMException("The stop request timed out.", "TimeoutError")),
                () => {},
            );
            set({ feedback: { kind: "none" }, stopRequest: request });
            try {
                await options.port.cancel(running.turnId, signal);
            } catch (cause) {
                if (signal.aborted && parent.aborted) {
                    throw cause;
                }
                if (get().stopRequest !== request) {
                    return;
                }
                // The turn can end while the request is in flight; its failure then has nothing left to report.
                const stillRunning = options.runningTurn()?.commandId === running.commandId;
                set({
                    stopRequest: null,
                    ...(stillRunning
                        ? {
                              feedback: {
                                  kind: "failed",
                                  commandId: running.commandId,
                                  message: deadline.signal.aborted
                                      ? "Stopping has not been confirmed. The agent may still be running. Try Stop again."
                                      : formatError(cause, "The agent output could not be stopped."),
                              },
                          }
                        : {}),
                });
            } finally {
                deadline.abort();
            }
        },
    }));
