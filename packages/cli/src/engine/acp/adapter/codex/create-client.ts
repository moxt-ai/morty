import { AcpExecutionError } from "../../acp-error.ts";
import type { AcpAgentDefinition } from "../../agent/agent-definition.ts";
import { CodexAcpAgent } from "../../harness/codex/agent.ts";
import type { CodexClientOptions } from "../../harness/codex/session-update.ts";
import { validateAgentRuntime } from "../agent-initialization.ts";

export async function createCodexClient(
    agent: AcpAgentDefinition,
    options: Omit<CodexClientOptions, "command" | "environment">,
    signal: AbortSignal,
): Promise<CodexAcpAgent> {
    if (agent.harness !== "codex") {
        throw new AcpExecutionError("The Codex adapter cannot use another agent.", {}, "agent_adapter_mismatch");
    }
    await validateAgentRuntime(agent, signal);
    const client = new CodexAcpAgent({ ...options, command: agent.command, environment: agent.environment });
    try {
        await client.initialize(signal);
        signal.throwIfAborted();
        return client;
    } catch (cause) {
        await client.dispose("force");
        throw cause;
    }
}
