import { DatabaseSync } from "node:sqlite";

const SQLITE_BUSY = 5;

/** The operating system releases the SQLite write transaction when its owning process exits. */
export function tryLock(path: string): (() => void) | null {
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
