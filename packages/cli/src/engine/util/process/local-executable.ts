import { realpathSync, statSync } from "node:fs";
import { ExecutableIdentity } from "./executable.ts";

/** The identity of a local executable file as it is now. */
export function readExecutableIdentity(path: string): ExecutableIdentity {
    const resolvedPath = realpathSync(path);
    const metadata = statSync(resolvedPath);
    return new ExecutableIdentity(
        resolvedPath,
        resolvedPath,
        metadata.dev,
        metadata.ino,
        metadata.size,
        metadata.ctimeMs,
    );
}
