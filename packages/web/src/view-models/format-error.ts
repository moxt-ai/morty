import { isRuntimeConnectionFailure } from "../services/management/management-api.ts";

const runtimeDisconnectedMessage = "Your Mobius is disconnected. Start your Mobius to reconnect, then try again.";

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
