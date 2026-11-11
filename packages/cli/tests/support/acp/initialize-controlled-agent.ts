import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/unstable";
import { AcpExecutionError } from "../../../src/engine/acp/acp-error.ts";
import { RetryableAcpInitializationError } from "../../../src/engine/acp/adapter/agent-initialization.ts";
import { normalizeAcpCapabilities } from "../../../src/engine/acp/protocol/session-capabilities.ts";
import { truncate } from "../../../src/engine/util/value-utils.ts";
import type { AgentConnection } from "../agents/agent-connection.ts";

export async function initializeAgentConnection(
    connection: Pick<AgentConnection, "connection" | "initialize" | "race">,
    harness: string,
    verifiedVersion: string,
    signal: AbortSignal,
) {
    await connection
        .race(connection.initialize(signal), "The Agent runtime exited during initialization", signal)
        .catch((cause: unknown) => {
            signal.throwIfAborted();
            throw new RetryableAcpInitializationError(cause);
        });
    const initialized = await connection
        .race(
            connection.connection.agent.request(
                methods.agent.initialize,
                {
                    clientCapabilities: {
                        elicitation: { form: {}, url: {} },
                        plan: {},
                        session: { compaction: {}, configOptions: { boolean: {} } },
                    },
                    clientInfo: { name: "morty", version: "0.0.3" },
                    protocolVersion: PROTOCOL_VERSION,
                },
                { cancellationSignal: signal },
            ),
            "ACP agent exited during initialization",
            signal,
        )
        .catch((cause: unknown) => {
            signal.throwIfAborted();
            throw new RetryableAcpInitializationError(cause);
        });
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
        throw new AcpExecutionError(
            "ACP agent selected an unsupported protocol version",
            {},
            "unsupported_acp_protocol",
        );
    }
    return {
        capabilities: normalizeAcpCapabilities(initialized),
        agentName: truncate(initialized.agentInfo?.title ?? initialized.agentInfo?.name ?? harness, 255),
        agentVersion: truncate(
            verifiedVersion.length > 0 ? verifiedVersion : (initialized.agentInfo?.version ?? ""),
            128,
        ),
    };
}
