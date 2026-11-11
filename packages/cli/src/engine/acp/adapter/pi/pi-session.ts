import type { AcpContentExternalizer } from "../../content/content-externalizer.ts";
import type { PiAcpAgent } from "../../harness/pi/upstream/dist/acp/agent.js";
import { HarnessSession } from "../harness-session.ts";
import { type PiCallbackParams, piClientCallbacks } from "./client-callbacks.ts";
import { createPiClient, type PiClientRuntime } from "./create-client.ts";

export interface PiWorkspace {
    readonly cwd: string;
}

export function startPiSession<Response extends { readonly sessionId: string }>(
    params: {
        readonly runtime: PiClientRuntime;
        readonly workspace: PiWorkspace;
        readonly callbacks: PiCallbackParams;
        readonly externalizer: Pick<AcpContentExternalizer, "update">;
        readonly signal: AbortSignal;
    },
    open: (agent: PiAcpAgent) => Promise<Response>,
) {
    return HarnessSession.start(
        {
            workspace: params.workspace,
            signal: params.signal,
            create: async (lifetime) => {
                const callbacks = piClientCallbacks(params.callbacks, params.externalizer, lifetime);
                return {
                    agent: await createPiClient(params.runtime, callbacks, params.signal),
                    drained: callbacks.drained,
                };
            },
        },
        open,
    );
}
