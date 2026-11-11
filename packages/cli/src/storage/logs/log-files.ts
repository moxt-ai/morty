import type { Stats } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const LOG_FILE_NAME_PATTERN = /^[\w.-]{1,128}\.log$/u;
/** True when a path is legitimately absent, rather than present and unreadable. */
function isAbsent(cause: unknown): boolean {
    return typeof cause === "object" && cause !== null && Reflect.get(cause, "code") === "ENOENT";
}

/** Collect logs only inside Morty's private computer directory. */
export async function findLogDirectories(
    root: string,
    unreadable: string[],
    signal: AbortSignal,
): Promise<readonly string[]> {
    const computer = join(root, "computer");
    signal.throwIfAborted();
    const logs = join(computer, "logs");
    for (const path of [computer, logs]) {
        const status = await directoryStatus(path);
        if (status !== "listed") {
            if (status === "unreadable") {
                unreadable.push(relative(root, path));
            }
            return [];
        }
    }
    return [logs];
}

/** The log file names in a log directory. An unreadable directory is added to `unreadable`, relative to `root`. */
export async function listLogFiles(directory: string, root: string, unreadable: string[]): Promise<readonly string[]> {
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && LOG_FILE_NAME_PATTERN.test(entry.name))
            .map((entry) => entry.name)
            .sort();
    } catch (cause) {
        if (!isAbsent(cause)) {
            unreadable.push(relative(root, directory));
        }
        return [];
    }
}

type DirectoryStatus = "listed" | "skipped" | "unreadable";

/**
 * Classify a directory without changing it. Symlinks are rejected so a planted
 * link cannot redirect the report outside the state root, and the owner check
 * keeps another user's files out of it; both are deliberate exclusions rather
 * than collection failures.
 */
async function directoryStatus(path: string): Promise<DirectoryStatus> {
    let metadata: Stats;
    try {
        metadata = await lstat(path);
    } catch (cause) {
        return isAbsent(cause) ? "skipped" : "unreadable";
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata)) {
        return "skipped";
    }
    return "listed";
}

export type OwnedLogFileRead =
    | { readonly kind: "read"; readonly content: string }
    | { readonly kind: "skipped" }
    | { readonly kind: "unreadable" };

/** Reads a log file this user owns. Absent files, links and other users' files are skipped. */
export async function readOwnedLogFile(path: string, signal: AbortSignal): Promise<OwnedLogFileRead> {
    let metadata: Stats;
    try {
        metadata = await lstat(path);
    } catch (cause) {
        return isAbsent(cause) ? { kind: "skipped" } : { kind: "unreadable" };
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata)) {
        return { kind: "skipped" };
    }
    try {
        return { kind: "read", content: await readFile(path, { encoding: "utf8", signal }) };
    } catch (cause) {
        // Cancellation is not evidence about the file: let it propagate so the
        // command fails as aborted rather than reporting a healthy log as broken.
        if (signal.aborted) {
            throw cause;
        }
        return { kind: "unreadable" };
    }
}

function ownedByCurrentUser(metadata: { readonly uid: number }): boolean {
    // Windows reports uid 0 for every file, so ownership is not a signal there.
    return process.getuid === undefined || metadata.uid === process.getuid();
}
