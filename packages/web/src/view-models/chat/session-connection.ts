import { type MobiusClient, MobiusError } from "@moxt-ai/mobius-sdk";

// The Session pane's connection state and its reconnect policy. The Mobius SDK
// already retries a dropped live stream quickly; this policy is the slower
// outer layer that reopens the Session after the SDK gives up or the Runtime is
// unreachable.

export type SessionConnection =
    | { readonly kind: "loading" }
    | { readonly kind: "session-loading-after-create" }
    | { readonly kind: "ready"; readonly client: MobiusClient }
    | { readonly kind: "reconnecting"; readonly message: string | null }
    | {
          readonly kind: "disconnected";
          readonly message: string;
          readonly retry: SessionReconnectRetry;
      }
    | {
          /** The Runtime closed the Session. Reopening it, which only the user chooses to do, resumes the connection. */
          readonly kind: "closed";
          /** The Runtime's explanation, or null when this page learned of the closing from a failed operation. */
          readonly reason: string | null;
          readonly reopen:
              | { readonly kind: "available" }
              | { readonly kind: "reopening" }
              | { readonly kind: "failed"; readonly message: string };
      }
    | { readonly kind: "failed"; readonly message: string };

type SessionReconnectRetry =
    | { readonly kind: "scheduled"; readonly remainingSeconds: number }
    | { readonly kind: "exhausted" };

const SESSION_RECONNECT_DELAYS_MS = [5_000, 10_000, 20_000] as const;
const SESSION_RECONNECT_DELAY_CAP_MS = 30_000;
const SESSION_AUTO_RECONNECT_ATTEMPTS = 7;

/** The live subscription ended without failing, which only happens when it was closed deliberately. */
const SESSION_UPDATES_ENDED_ERROR_CODE = "session_updates_ended";

export function sessionUpdatesEndedError(): MobiusError {
    return new MobiusError(
        SESSION_UPDATES_ENDED_ERROR_CODE,
        "Session updates disconnected. Reopen the Session to continue.",
    );
}

/** The failure message the connection shows, if any. */
export function connectionFailure(connection: SessionConnection): string | null {
    switch (connection.kind) {
        case "disconnected":
        case "failed":
        case "reconnecting":
            return connection.message;
        case "closed":
            return connection.reopen.kind === "failed" ? connection.reopen.message : null;
        case "loading":
        case "session-loading-after-create":
        case "ready":
            return null;
    }
}

/** Whether the connection reached a state that operations waiting for it can act on. */
export function isConnectionSettled(connection: SessionConnection): boolean {
    switch (connection.kind) {
        case "ready":
        case "failed":
        case "closed":
            return true;
        case "disconnected":
            return connection.retry.kind === "exhausted";
        case "loading":
        case "session-loading-after-create":
        case "reconnecting":
            return false;
    }
}

/**
 * The next retry after `consecutiveFailures` failed attempts: a scheduled
 * automatic retry with its delay, or none once the attempts are used up.
 */
export function sessionReconnectAttempt(
    consecutiveFailures: number,
): { readonly kind: "scheduled"; readonly delayMs: number } | { readonly kind: "exhausted" } {
    if (consecutiveFailures >= SESSION_AUTO_RECONNECT_ATTEMPTS) {
        return { kind: "exhausted" };
    }
    return {
        kind: "scheduled",
        delayMs: Math.min(
            SESSION_RECONNECT_DELAYS_MS[consecutiveFailures] ?? SESSION_RECONNECT_DELAY_CAP_MS,
            SESSION_RECONNECT_DELAY_CAP_MS,
        ),
    };
}

/** The disconnected state while an automatic retry counts down, or after retries are exhausted. */
export function disconnectedConnection(message: string, remainingMs: number | null): SessionConnection {
    return {
        kind: "disconnected",
        message,
        retry:
            remainingMs === null
                ? { kind: "exhausted" }
                : { kind: "scheduled", remainingSeconds: Math.ceil(remainingMs / 1000) },
    };
}
