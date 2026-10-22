import * as acp from "@agentclientprotocol/sdk";
import {
    type AcpEndpointTermination,
    InProcessAcpAgentDefinition,
    type InProcessAcpEndpoint,
} from "@moxt-ai/mobius/runtime";
import { fakeDaemonCapabilities } from "@moxt-ai/mobius-test-support/fake-daemon";

export type DefineInProcessAgent<Definition> = (
    ...options: ConstructorParameters<typeof InProcessAcpAgentDefinition>
) => Definition;

export const defineCurrentAgent: DefineInProcessAgent<InProcessAcpAgentDefinition> = (...options) =>
    new InProcessAcpAgentDefinition(...options);

/**
 * A stateful Agent with one model setting. Asked to "Remove settings", it removes
 * its configuration through a real ACP update; it answers any other prompt.
 * `define` registers it with the daemon release under test.
 */
export function createSettingsAgent<Definition>(define: DefineInProcessAgent<Definition>) {
    const sessions = new Map<string, acp.SessionConfigOption[]>();
    const configuration = (sessionId: string): acp.SessionConfigOption[] => {
        const options = sessions.get(sessionId);
        if (options === undefined) {
            throw new Error("Unknown controlled settings session");
        }
        return options;
    };
    const createEndpoint = (): InProcessAcpEndpoint => {
        const termination = Promise.withResolvers<AcpEndpointTermination>();
        const app = acp
            .agent({ name: "morty-settings-agent" })
            .onRequest(acp.methods.agent.initialize, () => ({
                agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, list: {}, resume: {} } },
                agentInfo: { name: "Settings Agent", version: "controlled-harness" },
                authMethods: [],
                protocolVersion: acp.PROTOCOL_VERSION,
            }))
            .onRequest(acp.methods.agent.session.new, () => {
                const sessionId = crypto.randomUUID();
                sessions.set(sessionId, [
                    {
                        id: "model",
                        name: "Model",
                        category: "model",
                        type: "select",
                        currentValue: "test-small",
                        options: [
                            { value: "test-small", name: "Test Small" },
                            { value: "test-large", name: "Test Large" },
                        ],
                    },
                ]);
                return { sessionId, configOptions: configuration(sessionId) };
            })
            .onRequest(acp.methods.agent.session.load, (context) => ({
                configOptions: configuration(context.params.sessionId),
            }))
            .onRequest(acp.methods.agent.session.resume, (context) => ({
                configOptions: configuration(context.params.sessionId),
            }))
            .onRequest(acp.methods.agent.session.setConfigOption, (context) => {
                const { configId, value, sessionId } = context.params;
                if (configId !== "model" || (value !== "test-small" && value !== "test-large")) {
                    throw new Error("Unknown controlled model");
                }
                const options = configuration(sessionId).map((option) =>
                    option.type === "select" ? { ...option, currentValue: value } : option,
                );
                sessions.set(sessionId, options);
                return { configOptions: options };
            })
            .onRequest(acp.methods.agent.session.list, () => ({ sessions: [] }))
            .onRequest(acp.methods.agent.session.prompt, async (context) => {
                const sessionId = context.params.sessionId;
                configuration(sessionId);
                const prompt = context.params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
                if (prompt !== "Remove settings") {
                    await context.client.notify(acp.methods.client.session.update, {
                        sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: `Settings Agent: ${prompt}` },
                        },
                    });
                    return { stopReason: "end_turn" };
                }
                sessions.set(sessionId, []);
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId,
                    update: { sessionUpdate: "config_option_update", configOptions: [] },
                });
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: "Settings removed" },
                    },
                });
                return { stopReason: "end_turn" };
            })
            .onRequest(acp.methods.agent.session.close, () => ({}));
        return {
            app: () => app,
            terminated: termination.promise,
            initialize: async (signal) => signal.throwIfAborted(),
            close: async () => termination.resolve({ kind: "closed" }),
        };
    };
    return define(
        "settings-test",
        "Settings Agent",
        process.execPath,
        createEndpoint,
        {},
        "controlled-harness",
        undefined,
        fakeDaemonCapabilities,
    );
}
