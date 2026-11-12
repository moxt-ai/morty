import { resolve } from "node:path";
import type { CatalogAgent } from "../agent/catalog.ts";
import { LocalAgentCatalog } from "../agent/catalog.ts";
import type { RuntimeAgentDependencies } from "../agent/runtime-agents.ts";
import type { ComputerCredentials } from "./connection/computer-credentials.ts";

/**
 * Where a Runtime keeps its local data, and the environment it runs and launches Agents with. The data directory is
 * passed explicitly and never selected from the Agent launch environment.
 */
export class RuntimeLocalContext {
    readonly agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>;
    readonly stateDirectory: string;
    readonly maxAcpProcesses: number;

    constructor(stateDirectory: string, agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>, maxAcpProcesses = 1000) {
        this.stateDirectory = resolve(stateDirectory);
        this.agentLaunchEnvironment = Object.freeze({ ...agentLaunchEnvironment });
        this.maxAcpProcesses = maxAcpProcesses;
    }
}

export function withRuntimeEnvironment(agent: CatalogAgent, environment: Readonly<NodeJS.ProcessEnv>): CatalogAgent {
    const launchEnvironment: Record<string, string> = {};
    for (const [name, value] of Object.entries(environment)) {
        if (typeof value === "string") {
            launchEnvironment[name] = value;
        }
    }
    return agent.withEnvironment({ ...launchEnvironment, ...agent.environment });
}

export interface RuntimeConfig {
    readonly adapters: RuntimeAgentDependencies["adapters"];
    readonly defaultWorkspace: string;

    readonly catalog: LocalAgentCatalog;
    readonly computerId: string;
    readonly localContext: RuntimeLocalContext;
    readonly relayUrl: URL;
    readonly credentials: ComputerCredentials;
    /**
     * Serves the definition a command should run against, re-discovering the Agent when its
     * executable changed since the catalog snapshot was taken.
     */
    readonly resolveAgent: (agent: CatalogAgent, signal: AbortSignal) => Promise<CatalogAgent>;
}

export interface ComputerConnectionConfig {
    readonly defaultWorkspace: string;
    readonly computerId: string;
    readonly relayUrl: URL;
    readonly credentials: ComputerCredentials;
}

export function createRuntimeConfig(
    connection: ComputerConnectionConfig,
    dependencies: RuntimeAgentDependencies,
    localContext: RuntimeLocalContext,
    resolveAgent: RuntimeConfig["resolveAgent"],
): RuntimeConfig {
    const runtimeAgents = dependencies.agents.map((agent) =>
        withRuntimeEnvironment(agent, localContext.agentLaunchEnvironment),
    );
    return {
        adapters: dependencies.adapters,
        defaultWorkspace: connection.defaultWorkspace,
        catalog: new LocalAgentCatalog(runtimeAgents),
        computerId: connection.computerId,
        localContext,
        relayUrl: connection.relayUrl,
        credentials: connection.credentials,
        resolveAgent,
    };
}
