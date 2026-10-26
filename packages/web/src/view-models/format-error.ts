import { MobiusError, SESSION_CLOSED_ERROR_CODE } from "@moxt-ai/mobius-sdk";
import { isChatBridgeError } from "../services/api/websocket-api-transport.ts";
import { isRuntimeConnectionFailure } from "../services/management/management-api.ts";

const runtimeDisconnectedFailure = {
    detail: "Start your Mobius to reconnect, then try again.",
    title: "Your Mobius is disconnected.",
} as const;

/** How a failure because the Runtime cannot be reached reads everywhere. */
export const runtimeDisconnectedMessage = `${runtimeDisconnectedFailure.title} ${runtimeDisconnectedFailure.detail}`;

export function describeSessionFailureMessage(
    message: string,
): Readonly<{ readonly title: string; readonly detail?: string }> {
    if (message === runtimeDisconnectedMessage) {
        return runtimeDisconnectedFailure;
    }
    return { title: message };
}
const retryableRuntimeFailureCodes = new Set(["runtime_offline", "service_unavailable"]);

/**
 * Map a caught error to the single user-facing message for it. Known error
 * codes are translated to unified copy here so the same failure reads the same
 * everywhere; any other Error keeps its own sanitized message, and a non-Error
 * cause falls back to the caller's context-specific message.
 */
export function formatError(cause: unknown, fallback: string): string {
    if (isRuntimeConnectionFailure(cause)) {
        return runtimeDisconnectedMessage;
    }
    return cause instanceof Error ? cause.message : fallback;
}

/**
 * Whether an operation failed because the Runtime closed the Session and nobody reopened it. The Session is not
 * broken: reopening it makes its operations work again.
 */
export function isSessionClosedFailure(cause: unknown): boolean {
    return cause instanceof MobiusError && cause.code === SESSION_CLOSED_ERROR_CODE;
}

/**
 * Whether a Session connection failure comes from the Runtime being unreachable.
 * Such failures heal once the Runtime returns (for example after a daemon
 * upgrade), so the Session keeps retrying them instead of settling as failed.
 */
export function isRetryableRuntimeConnectionFailure(cause: unknown): boolean {
    if (isChatBridgeError(cause) || isRuntimeConnectionFailure(cause)) {
        return true;
    }
    return cause instanceof MobiusError && retryableRuntimeFailureCodes.has(cause.code);
}
