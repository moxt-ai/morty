import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Where this computer keeps Morty's private state: the platform's local application data directory, which belongs to
 * this computer and its user and is not synced to their other computers. `configured` overrides it.
 */
export function resolveStateDirectory(configured: string, signal: AbortSignal): string {
    signal.throwIfAborted();
    const directory = configured !== "" ? configured : platformStateDirectory();
    if (directory === null || !isAbsolute(directory)) {
        throw Object.assign(
            new Error("Set MORTY_STATE_DIRECTORY to an absolute directory private to this computer and user"),
            { code: "STATE_DIRECTORY_REQUIRED" },
        );
    }
    return directory;
}

function platformStateDirectory(): string | null {
    switch (process.platform) {
        case "win32": {
            const local = process.env["LOCALAPPDATA"];
            return local !== undefined && isAbsolute(local) ? join(local, "Morty") : null;
        }
        case "darwin":
            return join(homedir(), "Library", "Application Support", "Morty");
        default: {
            const state = process.env["XDG_STATE_HOME"];
            return state !== undefined && isAbsolute(state)
                ? join(state, "morty")
                : join(homedir(), ".local", "state", "morty");
        }
    }
}
