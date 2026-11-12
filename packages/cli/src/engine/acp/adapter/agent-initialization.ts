import { revalidateExecutable } from "../../util/process/executable.ts";
import { AcpExecutionError } from "../acp-error.ts";
import type { AcpAgentDefinition } from "../agent/agent-definition.ts";

export class RetryableAcpInitializationError extends AcpExecutionError {
    constructor(cause: unknown) {
        super("ACP agent initialization failed", { cause });
        this.name = "RetryableAcpInitializationError";
    }
}

export async function validateAgentRuntime(
    agent: Pick<AcpAgentDefinition, "agentIdentity">,
    signal: AbortSignal,
): Promise<void> {
    signal.throwIfAborted();
    const unchanged = await revalidateExecutable(agent.agentIdentity);
    signal.throwIfAborted();
    if (!unchanged) {
        throw new AcpExecutionError(
            "The local Agent runtime changed; restart Morty before starting a new conversation",
            {},
            "agent_runtime_changed",
        );
    }
}
