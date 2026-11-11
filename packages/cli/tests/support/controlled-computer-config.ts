import type { CatalogAgent } from "../../src/engine/agent/catalog.ts";
import { ComputerAgentDependencies } from "../../src/engine/agent/computer-agents.ts";
import {
    type ComputerConfig,
    type ComputerConnectionConfig,
    ComputerLocalContext,
    type ComputerReconnectTarget,
    createComputerConfig,
} from "../../src/engine/computer/config.ts";
import { readStateDirectory } from "../../src/storage/state-directory.ts";
import { acpAdapters } from "./acp-adapters.ts";

/** Injects only the controlled Agent dependency; computer services and transports remain production code. */
export function createControlledComputerConfig(
    connection: ComputerConnectionConfig,
    agents: readonly CatalogAgent[] = [],
    context?: ComputerLocalContext,
    reconnectTarget?: ComputerReconnectTarget | null,
    resolveAgent?: ComputerConfig["resolveAgent"],
    rediscoverAgents?: ComputerConfig["rediscoverAgents"],
): ComputerConfig {
    return createComputerConfig(
        connection,
        new ComputerAgentDependencies(agents, acpAdapters),
        context ?? new ComputerLocalContext(readStateDirectory(), process.env),
        reconnectTarget,
        resolveAgent,
        rediscoverAgents,
    );
}
