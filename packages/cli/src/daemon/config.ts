import { join } from "node:path";
import { prepareCurrentDataDirectory } from "../storage/daemon/current-data.ts";
import { readStateDirectory } from "../storage/state-directory.ts";

export function resolveMaxAcpProcesses(environment: Readonly<NodeJS.ProcessEnv>): number {
    const configured = environment["MORTY_MAX_ACP_PROCESSES"];
    if (configured === undefined || configured === "") {
        return 1000;
    }
    const parsed = Number(configured);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("MORTY_MAX_ACP_PROCESSES must be a positive integer");
    }
    return parsed;
}

export async function prepareMortyEngineDataDir(
    version: string,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string> {
    const directory = await prepareCurrentDataDirectory(readStateDirectory(environment), version, signal);
    return join(directory, "installations", "build.morty.cli");
}
