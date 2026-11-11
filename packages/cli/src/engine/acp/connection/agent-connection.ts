import type { ClientConnection } from "@agentclientprotocol/sdk/unstable";
import type { AgentModelEffort } from "@morty-build/client/protocol";
import type { AgentTermination, BackgroundActivity, PromptDelegationStage } from "../agent/agent-lifecycle.ts";
import type { AcpClientHandler } from "./create-client.ts";

/** Adapter-owned runtime and transport for one ACP client. */
export interface AgentConnection {
    readonly connection: ClientConnection;
    readonly termination: Promise<AgentTermination>;
    readonly initialize: (signal: AbortSignal) => Promise<void>;
    readonly closeProcess: () => Promise<void>;
    readonly agentSettingsModelEffort: () => AgentModelEffort | null;
    readonly race: <T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal) => Promise<T>;
}

export interface AgentConnectionOptions {
    readonly cwd: string;
    readonly client: AcpClientHandler;
    readonly onBackgroundActivity?: (activity: BackgroundActivity) => void;
    readonly onPromptDelegation?: (stage: PromptDelegationStage) => Promise<void>;
}

export type AgentConnectionFactory = (
    options: AgentConnectionOptions & {
        readonly command: string;
        readonly environment: Readonly<Record<string, string>>;
    },
) => AgentConnection;
