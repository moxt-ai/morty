import {
    executableLaunch,
    platformSpawnOptions,
    spawnProcess,
    stopProcessTree,
} from "../../../util/process/executable.ts";
import type { PiProcessHost } from "../../harness/pi/upstream/dist/pi-rpc/process.js";

/** Morty owns Pi's launch group and descendants, including shell and Windows command launchers. */
export const piProcessHost: PiProcessHost = {
    spawn: (command, args, options) => {
        const launch = executableLaunch(command, args);
        return spawnProcess(launch.command, launch.arguments, {
            ...platformSpawnOptions,
            cwd: options.cwd,
            env: options.environment,
            shell: false,
            stdio: "pipe",
        });
    },
    stop: (child) => stopProcessTree(child),
};
