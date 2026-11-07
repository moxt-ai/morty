import { randomUUID } from "node:crypto";
import { access, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    type InstallationDirectory,
    writeInstallationFile,
} from "../../engine/storage/installation/installation-files.ts";
import { isNodeError } from "../../engine/util/node-error.ts";

const SQLITE_BUSY = 5;
type LockName = "manager.lock" | "installation.lock";

/** The operating system releases the SQLite write transaction when its owning process exits. */
function holdDaemonOwnership(path: string): (() => void) | null {
    const database = new DatabaseSync(path);
    try {
        database.exec("BEGIN IMMEDIATE");
        return () => database.close();
    } catch (cause) {
        database.close();
        if (cause instanceof Error && "errcode" in cause && cause.errcode === SQLITE_BUSY) {
            return null;
        }
        throw cause;
    }
}

/** SQLite owns exclusion. The PID file is diagnostic output and cannot authorize or prevent acquisition. */
export async function acquireDaemonLock(
    stateDirectory: InstallationDirectory,
    filename: LockName = "manager.lock",
): Promise<(() => Promise<void>) | null> {
    const path = join(stateDirectory, filename);
    const release = holdDaemonOwnership(`${path}.sqlite`);
    if (release === null) {
        return null;
    }
    try {
        await writeInstallationFile(path, `${process.pid.toString()}\n`, AbortSignal.timeout(10_000));
    } catch (cause) {
        release();
        throw cause;
    }
    return async () => {
        try {
            // Detach the diagnostic filename before deleting it so concurrent Windows readers cannot delay reuse.
            const detached = `${path}.${randomUUID()}.released`;
            await rename(path, detached);
            await unlink(detached);
        } finally {
            release();
        }
    };
}

/** Probe the same lock that acquisition holds; a PID can be stale or reused by an unrelated process. */
export async function daemonLockExists(
    stateDirectory: InstallationDirectory,
    filename: LockName = "manager.lock",
): Promise<boolean> {
    const path = join(stateDirectory, `${filename}.sqlite`);
    try {
        await access(path);
    } catch (cause) {
        if (isNodeError(cause, "ENOENT")) {
            return false;
        }
        throw cause;
    }
    const release = holdDaemonOwnership(path);
    if (release === null) {
        return true;
    }
    release();
    return false;
}
