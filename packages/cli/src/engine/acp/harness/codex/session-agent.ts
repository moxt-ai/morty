import type { ContentBlock, PromptResponse } from "@agentclientprotocol/sdk/unstable";
import type { AgentTermination } from "../../agent/agent-lifecycle.ts";
import type { CodexAppServerServerRequest } from "./app-server-client.ts";

/** Session behavior selected after opening; transport ownership stays with the native client. */
export interface CodexSessionAgent {
    readonly steeringSupported: boolean;
    /** False when another Codex client owns the thread and this connection only queues input for it. */
    readonly runsTurns: boolean;
    readonly prompt: (
        input: readonly unknown[],
        signal: AbortSignal,
        content: readonly ContentBlock[],
    ) => Promise<PromptResponse>;
    readonly steer: (
        params: unknown,
        signal: AbortSignal,
    ) => Promise<{ readonly outcome: "injected" } | { readonly outcome: "promptRequired"; readonly reason: string }>;
    readonly cancel: () => Promise<void>;
    readonly close: () => Promise<void>;
    /** Reports a manual compaction through thread/compact/start. Unsupported session
     *  agents (borrowed queue access) reject with an execution error. */
    readonly compact: (signal: AbortSignal) => Promise<PromptResponse>;
    readonly onNotification: (method: string, params: unknown) => Promise<void>;
    readonly onServerRequest: (request: CodexAppServerServerRequest) => Promise<void>;
    readonly onTerminated: (termination: AgentTermination) => void;
}
