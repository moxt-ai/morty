import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DAEMON_LOG_FILENAME = "daemon.log";
export const DAEMON_LIFECYCLE_LOG_FILENAME = "daemon-lifecycle.log";

export const UNHANDLED_REJECTION_LOG_FILENAME = "unhandled-rejections-daemon.log";

export function logDirectory(dataDirectory: string): string {
    return join(dataDirectory, "logs");
}

export function processLogPaths(dataDirectory: string): readonly string[] {
    return [
        DAEMON_LIFECYCLE_LOG_FILENAME,
        UNHANDLED_REJECTION_LOG_FILENAME,
        "worker-lifecycle.log",
        "unhandled-rejections-manager.log",
        "unhandled-rejections-worker.log",
    ].map((filename) => join(logDirectory(dataDirectory), filename));
}

export function readLogText(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
}
