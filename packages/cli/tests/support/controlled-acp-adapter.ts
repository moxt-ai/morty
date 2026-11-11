import { methods } from "@agentclientprotocol/sdk/unstable";
import { sessionCreationResponse } from "../../src/engine/acp/adapter/lifecycle-output.ts";
import { findNativeSession } from "../../src/engine/acp/adapter/native-session-lookup.ts";
import type { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import type { Adapter, AdapterDependencies } from "../../src/engine/acp/native-history/preview-contract.ts";
import { sessionIdSchema } from "../../src/engine/acp/protocol/native-session.ts";
import { runCleanup } from "../../src/engine/util/run-cleanup.ts";
import { AcpExecutionConnections } from "./acp/execution-connections.ts";
import { createdSessionId, normalizeOpenedSession, sessionWorkspace } from "./acp/lifecycle-output.ts";
import { AgentQueryProcesses } from "./acp/query-processes.ts";
import { AcpSessionConnector } from "./acp/session-events.ts";
import { ControlledAcpHistory } from "./controlled-acp-history.ts";

/** Controlled ACP peers use the production transport, never a named vendor's concrete harness. */
export class ControlledAcpAdapter implements Adapter {
    readonly #history: ControlledAcpHistory;
    readonly #queryProcesses: AgentQueryProcesses;
    readonly #executionConnections: AcpExecutionConnections;

    constructor(agent: AcpAgentDefinition, dependencies: AdapterDependencies) {
        const connector = new AcpSessionConnector(dependencies.contentExternalizer);
        this.#history = new ControlledAcpHistory(agent, dependencies.processes, connector);
        this.#executionConnections = new AcpExecutionConnections(dependencies.contentExternalizer);
        this.#queryProcesses = new AgentQueryProcesses(agent, dependencies.processes, connector);
    }

    readonly refreshAgent: Adapter["refreshAgent"] = (agent) => {
        this.#queryProcesses.refreshAgent(agent);
        this.#history.refreshAgent(agent);
    };
    readonly getCapabilities: Adapter["getCapabilities"] = (query) => this.#queryProcesses.capabilities(query);
    readonly createSession: Adapter["createSession"] = (params) =>
        this.#executionConnections.withConnection(params, async (execution, signal) => {
            const { connection } = execution;
            const response: unknown = await sessionCreationResponse(
                connection.race(
                    connection.connection.agent.request(methods.agent.session.new, sessionWorkspace(params.scope), {
                        cancellationSignal: signal,
                    }),
                    "ACP agent exited while starting a session",
                    signal,
                ),
                signal,
            );
            const sessionId = createdSessionId(response);
            this.#executionConnections.bind(execution, sessionId);
            return normalizeOpenedSession(execution, sessionId, response, signal);
        });
    readonly forkSession: Adapter["forkSession"] = (params) =>
        this.#executionConnections.withConnection(params, async (execution, signal) => {
            const { connection } = execution;
            const response: unknown = await connection.race(
                connection.connection.agent.request(
                    methods.agent.session.fork,
                    {
                        ...sessionWorkspace(params.scope),
                        sessionId: sessionIdSchema.parse(params.sourceSessionId),
                    },
                    { cancellationSignal: signal },
                ),
                "ACP agent exited while forking a session",
                signal,
            );
            const sessionId = createdSessionId(response);
            this.#executionConnections.bind(execution, sessionId);
            return normalizeOpenedSession(execution, sessionId, response, signal);
        });
    readonly openSession: Adapter["openSession"] = (params) =>
        this.#executionConnections.withConnection(params, async (execution, signal) => {
            const { connection } = execution;
            const sessionId = sessionIdSchema.parse(params.sessionId);
            this.#executionConnections.bind(execution, sessionId);
            const response: unknown = await connection.race(
                connection.connection.agent.request(
                    methods.agent.session.resume,
                    { ...sessionWorkspace(params.scope), sessionId },
                    { cancellationSignal: signal },
                ),
                "ACP agent exited while resuming a session",
                signal,
            );
            return normalizeOpenedSession(execution, sessionId, response, signal);
        });
    readonly openSessionWithReplay: Adapter["openSessionWithReplay"] = (params) =>
        this.#executionConnections.withConnection(params, async (execution, signal) => {
            const { connection } = execution;
            const sessionId = sessionIdSchema.parse(params.sessionId);
            this.#executionConnections.bind(execution, sessionId);
            const response: unknown = await connection.race(
                connection.connection.agent.request(
                    methods.agent.session.load,
                    { ...sessionWorkspace(params.scope), sessionId },
                    { cancellationSignal: signal },
                ),
                "ACP agent exited while loading a session",
                signal,
            );
            await connection.race(connection.events.drained(), "ACP agent exited while loading a session", signal);
            return normalizeOpenedSession(execution, sessionId, response, signal);
        });
    readonly cancel: Adapter["cancel"] = (...args) => this.#executionConnections.cancel(...args);
    readonly closeSession: Adapter["closeSession"] = (...args) => this.#executionConnections.closeSession(...args);
    readonly releaseSession: Adapter["releaseSession"] = (params) => this.#executionConnections.releaseSession(params);
    readonly readNativeHistoryRevision: Adapter["readNativeHistoryRevision"] = (params) =>
        this.#executionConnections.readNativeHistoryRevision(params);
    readonly prompt: Adapter["prompt"] = (...args) => this.#executionConnections.prompt(...args);
    readonly steer: Adapter["steer"] = (...args) => this.#executionConnections.steer(...args);
    readonly renameSession: Adapter["renameSession"] = (...args) => this.#executionConnections.renameSession(...args);
    readonly configureSession: Adapter["configureSession"] = (...args) =>
        this.#executionConnections.configureSession(...args);
    readonly listSessions: Adapter["listSessions"] = ({ query, cursor }) =>
        this.#queryProcesses.listNativeSessions(query, cursor);
    readonly findSession: Adapter["findSession"] = ({ query, sessionId, budget }) =>
        findNativeSession(this.listSessions, query, sessionId, budget);
    readonly readSessionHistory: Adapter["readSessionHistory"] = ({ query, request }) =>
        this.#history.read(query, request);
    readonly close = async (): Promise<void> =>
        await runCleanup(
            () => this.#history.close(),
            () => this.#queryProcesses.close(),
            () => this.#executionConnections.close(),
        );
}
