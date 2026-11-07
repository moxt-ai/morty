import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { executableLaunch, findExecutableOnPath, runBoundedProcess } from "../src/engine/util/process/executable.ts";

const directory = resolve(import.meta.dirname, "..");
const destination = resolve(directory, "../../.release");
await mkdir(destination, { recursive: true });
const npm = await findExecutableOnPath("npm", process.env);
if (npm === null) {
    throw new Error("npm is required to pack the release");
}
const launch = executableLaunch(npm.path, ["pack", "--ignore-scripts", "--pack-destination", destination]);
await runBoundedProcess({
    command: launch.command,
    arguments: launch.arguments,
    cwd: directory,
    environment: process.env,
    signal: AbortSignal.timeout(60_000),
    timeoutMilliseconds: 60_000,
    outputLimitBytes: 2 * 1024 * 1024,
});
