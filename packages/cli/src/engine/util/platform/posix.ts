import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalPathError } from "../filesystem/path-error.ts";
import type { PlatformSupport } from "./contracts.ts";

async function removeControlSocket(path: string): Promise<void> {
    try {
        await unlink(path);
    } catch (cause) {
        if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") {
            throw cause;
        }
    }
}

export const posixOperations = {
    controlSocketPath: (installationHash: string) =>
        join(tmpdir(), `morty-${process.getuid?.()}`, `${installationHash}.sock`),
    prepareControlSocket: async (path: string) => {
        const directory = dirname(path);
        await mkdir(directory, { mode: 0o700, recursive: true });
        const metadata = await lstat(directory);
        if (
            !metadata.isDirectory() ||
            metadata.isSymbolicLink() ||
            metadata.uid !== process.getuid?.() ||
            (metadata.mode & 0o077) !== 0
        ) {
            throw new LocalPathError("Control socket directory is not private and user-owned");
        }
        await removeControlSocket(path);
    },
    validateControlPeer: async (path: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const directory = await lstat(dirname(path));
        const socket = await lstat(path);
        if (
            !directory.isDirectory() ||
            directory.isSymbolicLink() ||
            directory.uid !== process.getuid?.() ||
            (directory.mode & 0o077) !== 0 ||
            !socket.isSocket() ||
            socket.uid !== process.getuid?.() ||
            (socket.mode & 0o077) !== 0
        ) {
            throw new LocalPathError("Control endpoint is not private and user-owned");
        }
    },
    secureControlSocket: async (path: string) => {
        await chmod(path, 0o600);
    },
    removeControlSocket,
    validatePathPermissions: async (path: string, directory: boolean, privateAccess: boolean, signal: AbortSignal) => {
        signal.throwIfAborted();
        const metadata = await lstat(path);
        if (process.getuid === undefined || metadata.uid !== process.getuid()) {
            throw new LocalPathError("Path is not user-owned");
        }
        if (privateAccess) {
            await chmod(path, directory ? 0o700 : 0o600);
        }
        signal.throwIfAborted();
    },
} satisfies Pick<
    PlatformSupport,
    | "controlSocketPath"
    | "prepareControlSocket"
    | "secureControlSocket"
    | "validateControlPeer"
    | "removeControlSocket"
    | "validatePathPermissions"
>;
