import { resolve } from "node:path";
import type { NativeSessionTarget } from "@morty-build/client/protocol";
import type { CatalogAgent } from "../agent/catalog.ts";
import { LocalAgentCatalog } from "../agent/catalog.ts";
import type { ComputerAgentDependencies } from "../agent/computer-agents.ts";
import type { ComputerCredentials } from "./connection/computer-credentials.ts";

/**
 * Where a Computer keeps its local data, and the environment it runs and launches Agents with. The data directory is
 * passed explicitly and never selected from the Agent launch environment.
 */
export class ComputerLocalContext {
    readonly agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>;
    readonly stateDirectory: string;
    readonly maxAcpProcesses: number;

    constructor(stateDirectory: string, agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>, maxAcpProcesses = 1000) {
        this.stateDirectory = resolve(stateDirectory);
        this.agentLaunchEnvironment = Object.freeze({ ...agentLaunchEnvironment });
        this.maxAcpProcesses = maxAcpProcesses;
    }
}

export function withComputerEnvironment(agent: CatalogAgent, environment: Readonly<NodeJS.ProcessEnv>): CatalogAgent {
    const launchEnvironment: Record<string, string> = {};
    for (const [name, value] of Object.entries(environment)) {
        if (typeof value === "string") {
            launchEnvironment[name] = value;
        }
    }
    return agent.withEnvironment({ ...launchEnvironment, ...agent.environment });
}

export interface ComputerReconnectTarget {
    readonly kind: "managed";
}

export interface ComputerConfig {
    readonly adapters: ComputerAgentDependencies["adapters"];
    readonly agents: readonly CatalogAgent[];
    readonly defaultWorkspace: string;

    readonly catalog: LocalAgentCatalog;
    readonly computerId: string;
    readonly localContext: ComputerLocalContext;
    readonly reconnectTarget: ComputerReconnectTarget | null;
    readonly relayUrl: URL;
    readonly credentials: ComputerCredentials;
    /** Stable embedding context for one Session; applied to a copied Agent before process reuse is checked. */
    readonly sessionEnvironment?: (context: NativeSessionTarget) => Readonly<Record<string, string>>;
    /**
     * Serves the definition a command should run against, re-discoving the Agent when its
     * executable changed since the catalog snapshot was taken. Undefined keeps the boot-time
     * snapshot: a changed executable fails the command instead of being re-discovered.
     */
    readonly resolveAgent?: (agent: CatalogAgent, signal: AbortSignal) => Promise<CatalogAgent>;
    /**
     * Re-runs the ready Agent inventory this config was built from, serving the Agent catalog
     * discovery command. Undefined keeps the boot-time catalog: the command fails instead.
     */
    readonly rediscoverAgents?: (signal: AbortSignal) => Promise<readonly CatalogAgent[]>;
}

export interface ComputerConnectionConfig {
    readonly defaultWorkspace: string;
    readonly computerId: string;
    readonly relayUrl: URL;
    readonly credentials: ComputerCredentials;
}

export function createComputerConfig(
    connection: ComputerConnectionConfig,
    dependencies: ComputerAgentDependencies,
    localContext: ComputerLocalContext,
    reconnectTarget: ComputerReconnectTarget | null = null,
    resolveAgent?: ComputerConfig["resolveAgent"],
    rediscoverAgents?: ComputerConfig["rediscoverAgents"],
): ComputerConfig {
    const computerAgents = dependencies.agents.map((agent) =>
        withComputerEnvironment(agent, localContext.agentLaunchEnvironment),
    );
    return {
        adapters: dependencies.adapters,
        agents: computerAgents,
        defaultWorkspace: connection.defaultWorkspace,
        catalog: new LocalAgentCatalog(computerAgents),
        computerId: connection.computerId,
        localContext,
        reconnectTarget,
        relayUrl: connection.relayUrl,
        credentials: connection.credentials,
        ...(resolveAgent === undefined ? {} : { resolveAgent }),
        ...(rediscoverAgents === undefined ? {} : { rediscoverAgents }),
    };
}
