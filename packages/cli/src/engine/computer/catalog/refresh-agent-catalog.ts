import type { CatalogAgent } from "../../agent/catalog.ts";
import { type ComputerConfig, withComputerEnvironment } from "../config.ts";
import { publishAgentCatalog } from "./publish-agent-catalog.ts";

/**
 * Re-reads the local Agent inventory and republishes the catalog, so Agents installed or signed in after the daemon
 * started become available without restarting it. The transition and publication commit together; a failed
 * publication keeps the previous catalog.
 */
export async function refreshAgentCatalog(
    config: ComputerConfig,
    discover: (signal: AbortSignal) => Promise<readonly CatalogAgent[]>,
    signal: AbortSignal,
) {
    const readyAgents = await discover(signal);
    signal.throwIfAborted();
    return await config.catalog.replaceAndPublish(
        () => readyAgents.map((agent) => withComputerEnvironment(agent, config.localContext.agentLaunchEnvironment)),
        (publishSignal) => publishAgentCatalog(config, publishSignal),
        signal,
    );
}
