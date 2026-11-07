import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpath } from "node:fs/promises";
import { readInstalledRelease, releaseEntry } from "./releases.ts";

const managedCommands = new Set(["start", "restart", "pair", "agents", "logs", "release"]);

/** The npm executable is a launcher; operational commands follow the selected durable release. */
export async function dispatchInstalledCommand(signal: AbortSignal): Promise<boolean> {
    const command = process.argv[2];
    const invoked = process.argv[1];
    if (command === undefined || invoked === undefined || !managedCommands.has(command)) {
        return false;
    }
    const release = await readInstalledRelease(signal);
    if (release === null || (await realpath(invoked)) === (await realpath(releaseEntry(release)))) {
        return false;
    }
    signal.throwIfAborted();
    const child = spawn(process.execPath, [releaseEntry(release), ...process.argv.slice(2)], {
        stdio: "inherit",
        windowsHide: true,
        signal,
    });
    const [code] = await once(child, "exit");
    process.exitCode = typeof code === "number" ? code : 1;
    return true;
}
