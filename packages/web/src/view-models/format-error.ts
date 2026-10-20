import { MobiusError } from "@moxt-ai/mobius-sdk";
import { isRuntimeConnectionFailure } from "../services/management/management-api.ts";

const runtimeDisconnectedMessage = "Your Mobius is disconnected. Start your Mobius to reconnect, then try again.";
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
 * Whether a Session connection failure comes from the Runtime being unreachable.
 * Such failures heal once the Runtime returns (for example after a daemon
 * upgrade), so the Session keeps retrying them instead of settling as failed.
 */
export function isRetryableRuntimeConnectionFailure(cause: unknown): boolean {
    if (isRuntimeConnectionFailure(cause)) {
        return true;
    }
    return cause instanceof MobiusError && retryableRuntimeFailureCodes.has(cause.code);
}
