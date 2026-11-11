import { createCodexClient } from "../../../acp/adapter/codex/create-client.ts";
import { CodexAcpAgent } from "../../../acp/harness/codex/agent.ts";
import { normalizeAcpCapabilities } from "../../../acp/protocol/session-capabilities.ts";
import {
    type AgentReadinessProbeParams,
    filterEnvironment,
    VerifiedAcpReadiness,
} from "../../discovery/acp-readiness-probe.ts";
import { AgentProbeError } from "../../discovery/agent-probe-error.ts";
import { InProcessAcpAgentSpecification } from "../agent-specification.ts";

// Discovery and sessions both drive the native app-server without an internal ACP endpoint.
export class CodexAgentSpecification extends InProcessAcpAgentSpecification {
    override readonly versionProbeTimeoutMilliseconds = 10_000;
    readonly agentExecutable = "codex";
    readonly createConnection = null;
    readonly harness = "codex";
    readonly label = "Codex";
    override readonly minimumSupportedAgentVersion = "0.153.0";

    constructor() {
        super("MORTY_CODEX_PATH");
    }

    override readonly probeReadiness = async (params: AgentReadinessProbeParams): Promise<VerifiedAcpReadiness> => {
        const timeout = AbortSignal.timeout(this.acpProbeTimeoutMilliseconds);
        const signal = AbortSignal.any([params.signal, timeout]);
        const reject = async (): Promise<never> => {
            throw new AgentProbeError("acp_incompatible", "The Codex readiness probe does not accept interactions");
        };
        try {
            const client = await createCodexClient(
                params.agent.withEnvironment({ ...filterEnvironment(params.environment), ...params.agent.environment }),
                {
                    cwd: params.defaultWorkspace,
                    onSessionUpdate: reject,
                    interactions: { onPermission: reject, onElicitation: reject },
                },
                signal,
            );
            try {
                return new VerifiedAcpReadiness(
                    CodexAcpAgent.capabilities().agentInfo.version,
                    normalizeAcpCapabilities(CodexAcpAgent.capabilities()),
                );
            } finally {
                await client.dispose("graceful");
            }
        } catch (cause) {
            params.signal.throwIfAborted();
            if (timeout.aborted) {
                throw new AgentProbeError("adapter_probe_timeout", "Codex readiness probe timed out", { cause });
            }
            if (cause instanceof AgentProbeError) {
                throw cause;
            }
            throw new AgentProbeError("acp_incompatible", "Codex initialization failed", { cause });
        }
    };
}
