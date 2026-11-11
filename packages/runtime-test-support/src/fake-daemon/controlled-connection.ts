import type { AgentApp, ClientConnection } from "@agentclientprotocol/sdk/unstable";
import type { AgentModelEffort } from "@morty-build/client/protocol";
import type { AgentTermination } from "../../../cli/src/engine/acp/agent/agent-lifecycle.ts";
import type { AgentConnection } from "../../../cli/src/engine/acp/connection/agent-connection.ts";
import { raceAgentOperation } from "../../../cli/src/engine/acp/connection/agent-operation.ts";
import { type AcpClientHandler, createAcpClient } from "../../../cli/src/engine/acp/connection/create-client.ts";

/** A stateful controlled peer, injected only by ACP boundary scenarios. */
export interface ControlledAcpPeer {
    readonly terminated: Promise<AgentTermination>;
    readonly app: () => AgentApp;
    readonly agentSettingsModelEffort?: () => AgentModelEffort;
    readonly initialize: (signal: AbortSignal) => Promise<void>;
    readonly close: () => Promise<void>;
}

/** Connects an injected stateful ACP endpoint to the production daemon. */
export class ControlledEndpointConnection implements AgentConnection {
    readonly #peer: ControlledAcpPeer;
    readonly connection: ClientConnection;
    readonly termination;
    #closePromise: Promise<void> | null = null;

    constructor(peer: ControlledAcpPeer, client: AcpClientHandler) {
        this.#peer = peer;
        this.termination = peer.terminated;
        this.connection = createAcpClient(client).connect(peer.app());
    }

    readonly initialize = async (signal: AbortSignal): Promise<void> => await this.#peer.initialize(signal);
    readonly agentSettingsModelEffort = () => this.#peer.agentSettingsModelEffort?.() ?? null;
    readonly closeProcess = (): Promise<void> => {
        this.#closePromise ??= (async () => {
            try {
                await this.#peer.close();
            } finally {
                this.connection.close();
            }
        })();
        return this.#closePromise;
    };
    readonly race = <T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal): Promise<T> =>
        raceAgentOperation(operation, this.termination, exitMessage, signal);
}
