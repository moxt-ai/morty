import type { MortyClient } from "@morty-build/client";
import type { ConnectionReadiness } from "./session-connection.ts";

/** What the following pane's connection can carry now, and where an operation's failure goes. */
interface Loan {
    readonly readiness: ConnectionReadiness;
    /** Hands the pane that lent the connection a failure, so a Session found closed closes that pane. */
    readonly failed: (cause: unknown) => void;
}

/** One pane's following of the Session: it reports each change of its connection and its own stop. */
export interface SessionConnectionFollower {
    readonly changed: (readiness: ConnectionReadiness, failed: (cause: unknown) => void) => void;
    readonly stopped: () => void;
}

/**
 * How the Session's operations reach the Runtime, whichever pane follows the Session. The pane that follows it lends
 * its connection; an operation waits while no ready connection is lent, so switching panes delays an operation instead
 * of ending it. A request already sent keeps the client it started with: closing a client ends only its live
 * subscriptions.
 */
export interface SessionOperationConnection {
    /** Starts lending a pane's connection, replacing any pane that followed the Session before. */
    readonly follow: () => SessionConnectionFollower;
    /** The ready client, waiting until one is lent; rejects when the lent connection cannot carry operations. */
    readonly ready: (signal: AbortSignal) => Promise<MortyClient>;
    /**
     * Sends `request` through the ready client, waiting for one until `signal` ends. A failure goes to the pane that
     * lent the client before it is rethrown.
     */
    readonly send: <Result>(
        request: (client: MortyClient, signal: AbortSignal) => Promise<Result>,
        signal: AbortSignal,
    ) => Promise<Result>;
}

export function createSessionOperationConnection(): SessionOperationConnection {
    let lent: Loan | null = null;
    let current: SessionConnectionFollower | null = null;
    const waiters = new Set<() => void>();
    const readyLoan = async (signal: AbortSignal): Promise<{ readonly client: MortyClient } & Loan> => {
        for (;;) {
            signal.throwIfAborted();
            const loan = lent;
            if (loan?.readiness.kind === "ready") {
                return { ...loan, client: loan.readiness.client };
            }
            if (loan?.readiness.kind === "unavailable") {
                throw loan.readiness.failure;
            }
            await new Promise<void>((resolve, reject) => {
                const wake = (): void => {
                    cleanup();
                    resolve();
                };
                const abort = (): void => {
                    cleanup();
                    reject(signal.reason);
                };
                const cleanup = (): void => {
                    waiters.delete(wake);
                    signal.removeEventListener("abort", abort);
                };
                waiters.add(wake);
                signal.addEventListener("abort", abort, { once: true });
            });
        }
    };
    return {
        follow: () => {
            const follower: SessionConnectionFollower = {
                changed: (readiness, failed) => {
                    if (current !== follower) {
                        return;
                    }
                    lent = { readiness, failed };
                    if (readiness.kind !== "waiting") {
                        for (const wake of [...waiters]) {
                            wake();
                        }
                    }
                },
                stopped: () => {
                    if (current === follower) {
                        current = null;
                        lent = null;
                    }
                },
            };
            current = follower;
            lent = null;
            return follower;
        },
        ready: async (signal) => (await readyLoan(signal)).client,
        send: async (request, signal) => {
            const loan = await readyLoan(signal);
            try {
                return await request(loan.client, signal);
            } catch (cause) {
                if (!signal.aborted) {
                    loan.failed(cause);
                }
                throw cause;
            }
        },
    };
}
