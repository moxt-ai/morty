import {
    AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION,
    type SessionConfigOption,
    type SessionConfigurationSelection,
} from "@morty-build/client/protocol";
import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";

export class AgentSettingsLaunchSelectionResult {
    readonly agent: AcpAgentDefinition;
    readonly handled: boolean;

    constructor(agent: AcpAgentDefinition, handled: boolean) {
        this.agent = agent;
        this.handled = handled;
    }
}

export class AppliedAgentLaunchSettings {
    readonly agent: AcpAgentDefinition;
    readonly sessionConfigurations: readonly SessionConfigurationSelection[];

    constructor(agent: AcpAgentDefinition, sessionConfigurations: readonly SessionConfigurationSelection[]) {
        this.agent = agent;
        this.sessionConfigurations = Object.freeze([...sessionConfigurations]);
    }
}

export class AgentSettingsAdapter {
    readonly modelEffortResolution: string = AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION;

    readonly applyLaunchSelection = (
        agent: AcpAgentDefinition,
        _selection: SessionConfigurationSelection,
    ): AgentSettingsLaunchSelectionResult => new AgentSettingsLaunchSelectionResult(agent, false);

    readonly settings = (_agent: AcpAgentDefinition): readonly SessionConfigOption[] => [];
}
