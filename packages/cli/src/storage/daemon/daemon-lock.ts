import { randomUUID } from "node:crypto";
import { access, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
    type InstallationDirectory,
    writeInstallationFile,
} from "../../engine/storage/installation/installation-files.ts";
import { tryLock } from "../../engine/storage/installation/local-lock.ts";
import { isNodeError } from "../../engine/util/node-error.ts";

/** SQLite owns exclusion. The PID file is diagnostic output and cannot authorize or prevent acquisition. */
export async function acquireDaemonLock(stateDirectory: InstallationDirectory): Promise<(() => Promise<void>) | null> {
    const path = join(stateDirectory, "manager.lock");
    const release = tryLock(`${path}.sqlite`);
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
export async function daemonLockExists(stateDirectory: InstallationDirectory): Promise<boolean> {
    const path = join(stateDirectory, "manager.lock.sqlite");
    try {
        await access(path);
    } catch (cause) {
        if (isNodeError(cause, "ENOENT")) {
            return false;
        }
        throw cause;
    }
    const release = tryLock(path);
    if (release === null) {
        return true;
    }
    release();
    return false;
}
