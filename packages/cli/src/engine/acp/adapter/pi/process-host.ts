import { platformSpawnOptions, spawnProcess, stopProcessTree } from "../../../util/process/executable.ts";
import type { PiProcessHost } from "../../harness/pi/upstream/dist/pi-rpc/process.js";

/** Morty owns Pi's launch group and descendants, including shell and Windows command launchers. */
export const piProcessHost: PiProcessHost = {
    spawn: (command, args, options) =>
        spawnProcess(command, args, {
            ...platformSpawnOptions,
            cwd: options.cwd,
            env: options.environment,
            shell: options.shell,
            stdio: "pipe",
        }),
    stop: (child) => stopProcessTree(child),
};
