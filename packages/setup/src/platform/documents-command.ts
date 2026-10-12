import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function documentsCommand(command: string, args: readonly string[], signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const { stdout } = await execute(command, [...args], {
        signal,
        timeout: 10000,
        maxBuffer: 65536,
        windowsHide: true,
    });
    signal.throwIfAborted();
    return stdout.trim();
}
