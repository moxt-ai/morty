import { join } from "node:path";
import {
    discoverLocalAgentInventory,
    type LocalAgentInventory,
} from "../../engine/agent/discovery/discover-local-agents.ts";
import { RuntimeLocalContext } from "../../engine/runtime/config.ts";
import { ensurePrivateDirectory } from "../../engine/storage/files/local-files.ts";
import { readStateDirectory } from "../../storage/state-directory.ts";
import { openMortyInstallation } from "../pairing/pair-local-computer.ts";

/** Discovers the Agents this installation could offer, and why each other installed Agent cannot be offered. */
export async function readLocalAgentInventory(
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
): Promise<LocalAgentInventory> {
    const installation = await openMortyInstallation(signal, environment);
    const localContext = new RuntimeLocalContext(installation.stateDirectory, environment);
    const defaultWorkspace = join(readStateDirectory(environment), "workspace");
    await ensurePrivateDirectory(defaultWorkspace);
    return await discoverLocalAgentInventory({
        defaultWorkspace,
        dataDirectory: localContext.stateDirectory,
        environment: localContext.agentLaunchEnvironment,
        signal,
    });
}
