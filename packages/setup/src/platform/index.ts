import { mortyStateDirectory } from "@morty-build/local-state";

export function resolveStateDirectory(configured: string, signal: AbortSignal): string {
    signal.throwIfAborted();
    return mortyStateDirectory({ ...process.env, MORTY_STATE_DIRECTORY: configured });
}
