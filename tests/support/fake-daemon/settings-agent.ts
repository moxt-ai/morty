import * as acp from "@agentclientprotocol/sdk";
import {
    ControlledEndpointConnection,
    type ControlledSessionUpdate,
    controlledSessionUpdates,
    fakeDaemonCapabilities,
} from "@moxt-ai/mobius-test-support/fake-daemon";
import { AcpAgentDefinition } from "../../../third-party/mobius/packages/cli/src/engine/acp/agent/agent-definition.ts";
import type {
    AcpEndpointTermination,
    InProcessAcpEndpoint,
} from "../../../third-party/mobius/packages/cli/src/engine/acp/agent/in-process-endpoint.ts";

export type DefineInProcessAgent<Definition> = (
    id: string,
    label: string,
    createEndpoint: (onSessionUpdate?: ControlledSessionUpdate) => InProcessAcpEndpoint,
) => Definition;

export const defineCurrentAgent: DefineInProcessAgent<AcpAgentDefinition> = (id, label, createEndpoint) =>
    new AcpAgentDefinition(
        id,
        label,
        process.execPath,
        (options) =>
            new ControlledEndpointConnection(createEndpoint(controlledSessionUpdates(options.client)), options.client),
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
    beforeConfigurationApplied?: (configId: string, value: string | boolean) => Promise<void>,
    beforeSessionCreated?: () => Promise<void>,
) {
    const sessions = new Map<string, acp.SessionConfigOption[]>();
    const histories = new Map<string, acp.SessionUpdate[]>();
    const configuration = (sessionId: string): acp.SessionConfigOption[] => {
        const options = sessions.get(sessionId);
        if (options === undefined) {
            throw new Error("Unknown controlled settings session");
        }
        return options;
    };
    const createEndpoint = (onSessionUpdate?: ControlledSessionUpdate): InProcessAcpEndpoint => {
        const termination = Promise.withResolvers<AcpEndpointTermination>();
        const app = acp
            .agent({ name: "morty-settings-agent" })
            .onRequest(acp.methods.agent.initialize, () => ({
                agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, list: {}, resume: {} } },
                agentInfo: { name: "Settings Agent", version: "controlled-harness" },
                authMethods: [],
                protocolVersion: acp.PROTOCOL_VERSION,
            }))
            .onRequest(acp.methods.agent.session.new, async () => {
                await beforeSessionCreated?.();
                const sessionId = crypto.randomUUID();
                histories.set(sessionId, []);
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
            .onRequest(acp.methods.agent.session.load, async (context) => {
                const sessionId = context.params.sessionId;
                for (const update of histories.get(sessionId) ?? []) {
                    if (onSessionUpdate === undefined) {
                        await context.client.notify(acp.methods.client.session.update, { sessionId, update });
                    } else {
                        await onSessionUpdate({ sessionId, update });
                    }
                }
                return { configOptions: configuration(sessionId) };
            })
            .onRequest(acp.methods.agent.session.resume, (context) => ({
                configOptions: configuration(context.params.sessionId),
            }))
            .onRequest(acp.methods.agent.session.setConfigOption, async (context) => {
                const { configId, value, sessionId } = context.params;
                await beforeConfigurationApplied?.(configId, value);
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
                const messageId = crypto.randomUUID();
                const replyId = crypto.randomUUID();
                configuration(sessionId);
                const prompt = context.params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
                const history = histories.get(sessionId);
                if (history === undefined) {
                    throw new Error("Unknown controlled settings history");
                }
                for (const content of context.params.prompt) {
                    const update: acp.SessionUpdate = { sessionUpdate: "user_message_chunk", content, messageId };
                    history.push(update);
                    const notification: acp.SessionNotification = { sessionId, update };
                    if (onSessionUpdate === undefined) {
                        await context.client.notify(acp.methods.client.session.update, notification);
                    } else {
                        await onSessionUpdate(notification);
                    }
                }
                if (prompt === "hold with consecutive user messages") {
                    const update: acp.SessionUpdate = {
                        sessionUpdate: "user_message_chunk",
                        messageId: crypto.randomUUID(),
                        content: { type: "text", text: "[Request interrupted by user]" },
                    };
                    history.push(update);
                    const notification: acp.SessionNotification = { sessionId, update };
                    if (onSessionUpdate === undefined) {
                        await context.client.notify(acp.methods.client.session.update, notification);
                    } else {
                        await onSessionUpdate(notification);
                    }
                    return { stopReason: "end_turn" };
                }
                if (prompt !== "Remove settings") {
                    const update: acp.SessionUpdate = {
                        sessionUpdate: "agent_message_chunk",
                        messageId: replyId,
                        content: {
                            type: "text",
                            text:
                                prompt === "Report current model"
                                    ? `Current model: ${configuration(sessionId).find((option) => option.id === "model")?.currentValue}`
                                    : `Settings Agent: ${prompt}`,
                        },
                    };
                    history.push(update);
                    if (onSessionUpdate === undefined) {
                        await context.client.notify(acp.methods.client.session.update, { sessionId, update });
                    } else {
                        await onSessionUpdate({ sessionId, update });
                    }
                    return { stopReason: "end_turn" };
                }
                sessions.set(sessionId, []);
                const updates: acp.SessionUpdate[] = [
                    { sessionUpdate: "config_option_update", configOptions: [] },
                    {
                        sessionUpdate: "agent_message_chunk",
                        messageId: replyId,
                        content: { type: "text", text: "Settings removed" },
                    },
                ];
                history.push(...updates);
                for (const update of updates) {
                    if (onSessionUpdate === undefined) {
                        await context.client.notify(acp.methods.client.session.update, { sessionId, update });
                    } else {
                        await onSessionUpdate({ sessionId, update });
                    }
                }
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
