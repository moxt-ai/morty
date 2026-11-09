import type { SessionConfigurationSelection } from "@morty-build/client/protocol";
import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import { AgentSettingsAdapter, AppliedAgentLaunchSettings } from "./agent-settings-base.ts";
import { CodexSettingsAdapter } from "./codex-settings-adapter.ts";

export {
    AgentSettingsAdapter,
    AppliedAgentLaunchSettings,
} from "./agent-settings-base.ts";

const genericAdapter = new AgentSettingsAdapter();
const codexAdapter = new CodexSettingsAdapter();

export function agentSettingsAdapterForAgent(harness: string): AgentSettingsAdapter {
    if (harness === "codex") {
        return codexAdapter;
    }
    return genericAdapter;
}

export function applyAgentLaunchSettings(
    agent: AcpAgentDefinition,
    selections: readonly SessionConfigurationSelection[],
): AppliedAgentLaunchSettings {
    const adapter = agentSettingsAdapterForAgent(agent.harness);
    let selectedAgent = agent;
    const sessionConfigurations: SessionConfigurationSelection[] = [];
    for (const selection of selections) {
        const applied = adapter.applyLaunchSelection(selectedAgent, selection);
        selectedAgent = applied.agent;
        if (!applied.handled) {
            sessionConfigurations.push(selection);
        }
    }
    return new AppliedAgentLaunchSettings(selectedAgent, sessionConfigurations);
}
