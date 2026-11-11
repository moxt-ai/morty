import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";

export interface AgentReadinessProbeParams {
    readonly agent: AcpAgentDefinition;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly defaultWorkspace: string;
    readonly signal: AbortSignal;
}

export function filterEnvironment(environment: Readonly<NodeJS.ProcessEnv>): Readonly<Record<string, string>> {
    const filtered: Record<string, string> = {};
    for (const [name, value] of Object.entries(environment)) {
        if (typeof value === "string") {
            filtered[name] = value;
        }
    }
    return filtered;
}
