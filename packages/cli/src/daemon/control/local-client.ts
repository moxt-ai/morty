import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { hostPlatform as managerPlatform } from "../../engine/util/platform/index.ts";
import { readOrCreateControlToken } from "../../storage/daemon/control-token.ts";

export const CONTROL_TIMEOUT_MILLISECONDS = 130_000;
const MAXIMUM_MESSAGE_BYTES = 64 * 1024;

export function controlSocketPath(stateDirectory: InstallationDirectory): string {
    const installationHash = createHash("sha256").update(stateDirectory).digest("hex").slice(0, 32);
    return managerPlatform.controlSocketPath(installationHash);
}

export async function readSocketMessage(socket: Socket, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (socket.destroyed || socket.readableEnded) {
        throw new Error("The manager connection closed without a response");
    }
    return await new Promise((resolve, reject) => {
        let encoded = "";
        const finish = (error?: unknown, value?: unknown): void => {
            signal.removeEventListener("abort", abort);
            socket.off("data", data);
            socket.off("error", onError);
            socket.off("end", end);
            if (error === undefined) {
                resolve(value);
            } else {
                reject(error);
            }
        };
        const abort = (): void => {
            socket.destroy();
            finish(signal.reason);
        };
        const data = (chunk: Buffer): void => {
            encoded += chunk.toString("utf8");
            if (encoded.length > MAXIMUM_MESSAGE_BYTES) {
                finish(new Error("The manager message is too large"));
                socket.destroy();
                return;
            }
            const newline = encoded.indexOf("\n");
            if (newline >= 0) {
                try {
                    finish(undefined, JSON.parse(encoded.slice(0, newline)));
                } catch (cause) {
                    finish(cause);
                }
            }
        };
        const onError = (cause: Error): void => finish(cause);
        const end = (): void => finish(new Error("The manager connection closed without a response"));
        socket.on("data", data);
        socket.once("error", onError);
        socket.once("end", end);
        signal.addEventListener("abort", abort, { once: true });
    });
}

export async function sendLocalRequest(
    stateDirectory: InstallationDirectory,
    command: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
): Promise<unknown> {
    const token = await readOrCreateControlToken(stateDirectory);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MILLISECONDS)]);
    deadline.throwIfAborted();
    const path = controlSocketPath(stateDirectory);
    await managerPlatform.validateControlPeer(path, deadline);
    const socket = createConnection(path);
    try {
        await new Promise<void>((resolve, reject) => {
            const abort = (): void => {
                socket.destroy();
                reject(deadline.reason);
            };
            socket.once("connect", () => {
                deadline.removeEventListener("abort", abort);
                resolve();
            });
            socket.once("error", reject);
            deadline.addEventListener("abort", abort, { once: true });
        });
        socket.write(`${JSON.stringify({ ...command, token })}\n`);
        return await readSocketMessage(socket, deadline);
    } finally {
        socket.destroy();
    }
}
