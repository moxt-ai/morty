import * as acp from "@agentclientprotocol/sdk";
import { AcpAgentDefinition, type AcpEndpointTermination, type InProcessAcpEndpoint } from "@moxt-ai/mobius/runtime";
import { ControlledEndpointConnection, fakeDaemonCapabilities } from "@moxt-ai/mobius-test-support/fake-daemon";

export type DefineInProcessAgent<Definition> = (
    id: string,
    label: string,
    createEndpoint: () => InProcessAcpEndpoint,
) => Definition;

export const defineCurrentAgent: DefineInProcessAgent<AcpAgentDefinition> = (id, label, createEndpoint) =>
    new AcpAgentDefinition(
        id,
        label,
        process.execPath,
        (options) => new ControlledEndpointConnection(createEndpoint(), options.client),
        {},
        "controlled-harness",
        undefined,
        fakeDaemonCapabilities,
    );

/**
 * A stateful Agent with one model setting. Asked to "Remove settings", it removes
 * its configuration through a real ACP update; it answers any other prompt.
 * `define` registers it with the daemon release under test.
 */
export function createSettingsAgent<Definition>(
    define: DefineInProcessAgent<Definition>,
    profile: "model" | "full" = "model",
) {
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
                            ...(profile === "full"
                                ? Array.from({ length: 20 }, (_, index) => ({
                                      value: `test-model-${index}`,
                                      name: `Test model ${index} with a descriptive name`,
                                  }))
                                : []),
                        ],
                    },
                ]);
                if (profile === "full") {
                    sessions.set(sessionId, [
                        {
                            id: "mode",
                            name: "Mode",
                            type: "select",
                            currentValue: "default",
                            options: [
                                { value: "default", name: "Default" },
                                { value: "plan", name: "Plan" },
                            ],
                        },
                        ...configuration(sessionId),
                        {
                            id: "effort",
                            name: "Effort",
                            type: "select",
                            currentValue: "high",
                            options: [
                                { value: "high", name: "High" },
                                { value: "low", name: "Low" },
                            ],
                        },
                        { id: "fast", name: "Fast mode", type: "boolean", currentValue: false },
                    ]);
                }
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
                const current = configuration(sessionId).find((option) => option.id === configId);
                if (current === undefined) {
                    throw new Error("Unknown controlled setting");
                }
                const options = configuration(sessionId).map((option) => {
                    if (option.id !== configId) {
                        return option;
                    }
                    if (option.type === "boolean" && typeof value === "boolean") {
                        return { ...option, currentValue: value };
                    }
                    if (
                        option.type === "select" &&
                        typeof value === "string" &&
                        option.options.some((choice) => "value" in choice && choice.value === value)
                    ) {
                        return { ...option, currentValue: value };
                    }
                    throw new Error("Unknown controlled setting value");
                });
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
    return define(profile === "full" ? "configuration-test" : "settings-test", "Settings Agent", createEndpoint);
}

/** How an installed Agent fails to open a session: signed out like a real harness, or broken. */
export type UnavailableAgentFailure = "signed-out" | "broken";

/** An installed Agent that refuses every new session, as a real harness does when it cannot start. */
export function createUnavailableAgent(id: string, name: string, failure: UnavailableAgentFailure) {
    const createEndpoint = (): InProcessAcpEndpoint => {
        const termination = Promise.withResolvers<AcpEndpointTermination>();
        const app = acp
            .agent({ name: "morty-unavailable-agent" })
            .onRequest(acp.methods.agent.initialize, () => ({
                agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, list: {}, resume: {} } },
                agentInfo: { name, version: "controlled-harness" },
                authMethods: [],
                protocolVersion: acp.PROTOCOL_VERSION,
            }))
            .onRequest(acp.methods.agent.session.new, () => {
                switch (failure) {
                    case "signed-out":
                        throw acp.RequestError.authRequired();
                    case "broken":
                        throw acp.RequestError.internalError();
                    default:
                        return failure satisfies never;
                }
            })
            .onRequest(acp.methods.agent.session.list, () => ({ sessions: [] }));
        return {
            app: () => app,
            terminated: termination.promise,
            initialize: async (signal) => signal.throwIfAborted(),
            close: async () => termination.resolve({ kind: "closed" }),
        };
    };
    return defineCurrentAgent(id, name, createEndpoint);
}
