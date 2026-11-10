import type { ClientConnection } from "@agentclientprotocol/sdk/unstable";
import type { AgentModelEffort } from "@morty-build/client/protocol";
import type {
    AcpEndpointTermination,
    BackgroundActivity,
    PromptDelegationStage,
} from "../agent/in-process-endpoint.ts";
import type { AcpClientHandler } from "./create-client.ts";

/** Adapter-owned runtime and transport for one ACP client. */
export interface AgentConnection {
    readonly connection: ClientConnection;
    readonly termination: Promise<AcpEndpointTermination>;
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

export interface AgentConnectionLaunchOptions extends AgentConnectionOptions {
    readonly command: string;
    readonly environment: Readonly<Record<string, string>>;
}

export type AgentConnectionFactory = (options: AgentConnectionLaunchOptions) => AgentConnection;
