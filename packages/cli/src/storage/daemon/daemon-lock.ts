import { randomUUID } from "node:crypto";
import { readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    createInstallationFile,
    type InstallationDirectory,
} from "../../engine/storage/installation/installation-files.ts";
import { isNodeError } from "../../engine/util/node-error.ts";

const SQLITE_BUSY = 5;
const OWNERSHIP_CONTENTION_MILLISECONDS = 2_000;

/**
 * Frees the lock name in one step. On Windows a file that is being unlinked stays
 * in place until the deleting handle closes, and opening or recreating it fails
 * with EPERM meanwhile; renaming it away first means no reader or acquirer of the
 * lock name ever sees that state. A failure leaves the file in place, where its
 * dead owner's PID marks it as stale.
 */
async function removeLockFile(path: string): Promise<void> {
    const released = `${path}.${randomUUID()}.released`;
    try {
        await rename(path, released);
    } catch {
        return;
    }
    await unlink(released).catch(() => undefined);
}

/**
 * The lock that makes one process the daemon among releases that take it: SQLite's exclusive lock on `<lock>.sqlite`,
 * which the operating system holds for the process and frees when it exits, however it exits. Its holder's PID is
 * recorded, so the next holder knows which lock file a crashed holder left, even after that PID was reused.
 */
function holdDaemonOwnership(
    path: string,
): { readonly previousOwner: number | null; readonly release: () => void } | null {
    const database = new DatabaseSync(path);
    try {
        // Contenders starting together briefly hold the file's other locks; waiting out that moment lets one of them
        // win instead of all of them failing. A held daemon lock outlasts the wait, so later contenders give up.
        database.exec(`PRAGMA busy_timeout = ${OWNERSHIP_CONTENTION_MILLISECONDS.toString()}`);
        database.exec("BEGIN EXCLUSIVE");
        // Only the winner keeps its locks: the exclusive locking mode retains the lock after the transaction commits,
        // until the connection closes. Set before winning, it would also keep a loser's read lock and block the winner.
        database.exec("PRAGMA locking_mode = EXCLUSIVE");
    } catch (cause) {
        database.close();
        if (cause instanceof Error && "errcode" in cause && cause.errcode === SQLITE_BUSY) {
            return null;
        }
        throw cause;
    }
    try {
        database.exec(
            "CREATE TABLE IF NOT EXISTS daemon_owner (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), pid INTEGER NOT NULL)",
        );
        const previous = database.prepare("SELECT pid FROM daemon_owner").get();
        database.prepare("INSERT OR REPLACE INTO daemon_owner (singleton, pid) VALUES (1, ?)").run(process.pid);
        database.exec("COMMIT");
        return {
            previousOwner: typeof previous?.["pid"] === "number" ? previous["pid"] : null,
            release: () => database.close(),
        };
    } catch (cause) {
        database.close();
        throw cause;
    }
}

/**
 * Takes the lock file that earlier releases take and read. Only the ownership holder calls this, so contenders never
 * take each other's lock file: one a crashed holder left is replaced, and one a live process of an earlier release holds
 * is kept. Returns the release function, or null when that process holds it.
 */
async function takeLockFile(path: string, previousOwner: number | null): Promise<(() => Promise<void>) | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            // A contender never reads an empty lock and mistakes its live owner for a dead one.
            await createInstallationFile(path, `${process.pid.toString()}\n`);
            return async () => await removeLockFile(path);
        } catch (cause) {
            if (!isNodeError(cause, "EEXIST")) {
                throw cause;
            }
            const encoded = await readFile(path, "utf8").catch(() => "");
            const pid = Number(encoded.trim());
            // The previous ownership holder no longer holds the lock, so its lock file is stale whatever its PID names
            // now. Any other PID was written by an earlier release, whose daemon holds the lock while it is alive.
            if (Number.isSafeInteger(pid) && pid > 1 && pid !== previousOwner) {
                try {
                    process.kill(pid, 0);
                    return null;
                } catch (probeCause) {
                    if (!isNodeError(probeCause, "ESRCH")) {
                        return null;
                    }
                }
            }
            await removeLockFile(path);
        }
    }
    return null;
}

/** Makes this process the only daemon. Returns the release function, or null when another daemon holds the lock. */
export async function acquireDaemonLock(
    stateDirectory: InstallationDirectory,
    filename: "manager.lock" | "worker.lock" = "manager.lock",
): Promise<(() => Promise<void>) | null> {
    const path = join(stateDirectory, filename);
    const ownership = holdDaemonOwnership(`${path}.sqlite`);
    if (ownership === null) {
        return null;
    }
    let releaseLockFile: (() => Promise<void>) | null = null;
    try {
        releaseLockFile = await takeLockFile(path, ownership.previousOwner);
    } finally {
        if (releaseLockFile === null) {
            ownership.release();
        }
    }
    if (releaseLockFile === null) {
        return null;
    }
    const release = releaseLockFile;
    return async () => {
        await release();
        ownership.release();
    };
}

/** Keep the released lock filename; a dead owner does not keep the daemon alive. */
export async function daemonLockExists(
    stateDirectory: InstallationDirectory,
    filename: "manager.lock" | "worker.lock" = "manager.lock",
): Promise<boolean> {
    try {
        const pid = Number((await readFile(join(stateDirectory, filename), "utf8")).trim());
        // An earlier release can expose the exclusive file before it finishes writing the PID.
        if (!Number.isSafeInteger(pid) || pid <= 1) {
            return true;
        }
        try {
            process.kill(pid, 0);
        } catch (cause) {
            if (isNodeError(cause, "ESRCH")) {
                return false;
            }
            if (!isNodeError(cause, "EPERM")) {
                throw cause;
            }
        }
        return true;
    } catch (cause) {
        if (isNodeError(cause, "ENOENT")) {
            return false;
        }
        // Released versions unlink their lock in place. On Windows the file cannot
        // be opened until that deletion completes, so it still exists.
        if (isNodeError(cause, "EPERM")) {
            return true;
        }
        throw cause;
    }
}
