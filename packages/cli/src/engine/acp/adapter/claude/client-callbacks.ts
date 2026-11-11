import { AcpExecutionError } from "../../acp-error.ts";
import type { AcpContentExternalizer } from "../../content/content-externalizer.ts";
import type { AcpClient } from "../../harness/claude/upstream/dist/acp-agent.js";
import { type HarnessCallbackParams, HarnessClientEvents } from "../harness-client-events.ts";
import type { HarnessLifetime } from "../harness-session.ts";

export function claudeClientCallbacks(
    params: HarnessCallbackParams,
    externalizer: Pick<AcpContentExternalizer, "update">,
    lifetime: HarnessLifetime,
): AcpClient & { readonly drained: () => Promise<void> } {
    const events = new HarnessClientEvents("claude", params, externalizer, lifetime);
    const unsupported = async (): Promise<never> => {
        throw new AcpExecutionError(
            "The harness requested an unsupported client operation",
            {},
            "agent_interaction_unsupported",
        );
    };
    return {
        sessionUpdate: events.receive,
        requestPermission: (request, signal = lifetime.signal) => events.permission(request, signal),
        createElicitation: (request, signal = lifetime.signal) => events.elicitation(request, signal),
        completeElicitation: async (notification) => {
            await params.interactions.onElicitationComplete?.(notification);
        },
        readTextFile: unsupported,
        writeTextFile: unsupported,
        extNotification: unsupported,
        drained: events.drained,
    };
}
