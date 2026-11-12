import type { CatalogAgent } from "../../src/engine/agent/catalog.ts";
import {
    type ComputerConnectionConfig,
    createRuntimeConfig,
    RuntimeAgentDependencies,
    type RuntimeConfig,
    RuntimeLocalContext,
} from "../../src/engine/runtime/config.ts";
import { readStateDirectory } from "../../src/storage/state-directory.ts";
import { acpAdapters } from "./acp-adapters.ts";

/** Injects only the controlled Agent dependency; computer services and transports remain production code. */
export function createControlledRuntimeConfig(
    connection: ComputerConnectionConfig,
    agents: readonly CatalogAgent[] = [],
    context?: RuntimeLocalContext,
    resolveAgent: RuntimeConfig["resolveAgent"] = async (agent) => agent,
): RuntimeConfig {
    return createRuntimeConfig(
        connection,
        new RuntimeAgentDependencies(agents, acpAdapters),
        context ?? new RuntimeLocalContext(readStateDirectory(), process.env),
        resolveAgent,
    );
}
