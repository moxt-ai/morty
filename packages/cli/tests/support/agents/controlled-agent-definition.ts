import type { AcpAgentDefinition } from "../../../src/engine/acp/agent/agent-definition.ts";
import { testAgentDefinition } from "../agent-definition.ts";
import type { AgentConnection, AgentConnectionFactory, AgentConnectionOptions } from "./agent-connection.ts";

// Environment copies and discovery's final definition retain the verified executable identity.
// Keep controlled transport configuration in the test adapter, outside the production Agent model.
const factories = new WeakMap<AcpAgentDefinition["agentIdentity"], AgentConnectionFactory>();

export function registerControlledConnection(agent: AcpAgentDefinition, factory: AgentConnectionFactory): void {
    factories.set(agent.agentIdentity, factory);
}

export function createControlledAgent(
    factory: AgentConnectionFactory,
    ...parameters: Parameters<typeof testAgentDefinition>
): AcpAgentDefinition {
    const agent = testAgentDefinition(...parameters);
    registerControlledConnection(agent, factory);
    return agent;
}

export function connectControlledAgent(agent: AcpAgentDefinition, options: AgentConnectionOptions): AgentConnection {
    const factory = factories.get(agent.agentIdentity);
    if (factory === undefined) {
        throw new Error("No controlled ACP connection was registered for this Agent");
    }
    return factory({ ...options, command: agent.command, environment: agent.environment });
}
