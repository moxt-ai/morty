import * as acp from "@agentclientprotocol/sdk";
import {
    type AcpEndpointTermination,
    InProcessAcpAgentDefinition,
    type InProcessAcpEndpoint,
} from "@moxt-ai/mobius/runtime";
import { fakeDaemonCapabilities } from "@moxt-ai/mobius-test-support/fake-daemon";

/** Stateful ACP peer that deliberately leaves tool status updates unfinished at turn termination. */
export function createToolLifecycleAgent() {
    const sessions = new Map<string, acp.SessionNotification[]>();
    const steeringToolCounts = new Map<string, number>();
    const heldSteering = new Set<string>();
    const createEndpoint = (): InProcessAcpEndpoint => {
        const termination = Promise.withResolvers<AcpEndpointTermination>();
        const lifetime = new AbortController();
        const turns = new Map<string, AbortController>();
        const app = acp
            .agent({ name: "tool-lifecycle-agent" })
            .onRequest(acp.methods.agent.initialize, () => ({
                _meta: { steering: { supported: true } },
                agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, list: {}, resume: {} } },
                agentInfo: { name: "Tool Lifecycle Agent", version: "controlled-harness" },
                authMethods: [],
                protocolVersion: acp.PROTOCOL_VERSION,
            }))
            .onRequest(acp.methods.agent.session.new, () => {
                const sessionId = crypto.randomUUID();
                sessions.set(sessionId, []);
                return { sessionId, configOptions: [] };
            })
            .onRequest(acp.methods.agent.session.load, async (context) => {
                for (const event of sessions.get(context.params.sessionId) ?? []) {
                    await context.client.notify(acp.methods.client.session.update, event);
                }
                return { configOptions: [] };
            })
            .onRequest(acp.methods.agent.session.resume, () => ({ configOptions: [] }))
            .onRequest(acp.methods.agent.session.list, () => ({ sessions: [] }))
            .onRequest(acp.methods.agent.session.prompt, async (context) => {
                const sessionId = context.params.sessionId;
                const history = sessions.get(sessionId);
                if (history === undefined) {
                    throw new Error("Unknown controlled session");
                }
                const prompt = context.params.prompt
                    .flatMap((content) => (content.type === "text" ? [content.text] : []))
                    .join("\n");
                steeringToolCounts.set(sessionId, prompt === "hold paginated steering" ? 27 : 1);
                if (prompt === "hold steering acknowledgement") {
                    heldSteering.add(sessionId);
                } else {
                    heldSteering.delete(sessionId);
                }
                const cancellation = new AbortController();
                turns.set(sessionId, cancellation);
                const signal = AbortSignal.any([context.signal, lifetime.signal, cancellation.signal]);
                try {
                    for (const [title, status] of [
                        ["Completed verification", "completed"],
                        ["Failed verification", "failed"],
                        ["Unfinished verification", "in_progress"],
                        ["Pending verification", "pending"],
                    ] satisfies readonly (readonly [string, acp.ToolCallStatus])[]) {
                        const event: acp.SessionNotification = {
                            sessionId,
                            update: {
                                sessionUpdate: "tool_call",
                                toolCallId: crypto.randomUUID(),
                                title,
                                status,
                                kind: "other",
                                rawInput: { task: title },
                            },
                        };
                        history.push(event);
                        await context.client.notify(acp.methods.client.session.update, event);
                    }
                    if (prompt === "fail unfinished tools") {
                        throw new Error("Controlled Agent execution failed");
                    }
                    if (prompt === "complete unfinished tools") {
                        return { stopReason: "end_turn" };
                    }
                    if (prompt === "hold tools across history pages") {
                        for (let index = 0; index < 250; index += 1) {
                            const event: acp.SessionNotification = {
                                sessionId,
                                update: {
                                    sessionUpdate: "agent_message_chunk",
                                    messageId: crypto.randomUUID(),
                                    content: { type: "text", text: `Progress item ${index}` },
                                },
                            };
                            history.push(event);
                            await context.client.notify(acp.methods.client.session.update, event);
                        }
                    }
                    const finished = Promise.withResolvers<acp.PromptResponse>();
                    const abort = () => finished.resolve({ stopReason: "cancelled" });
                    signal.addEventListener("abort", abort, { once: true });
                    try {
                        if (signal.aborted) {
                            abort();
                        }
                        return await finished.promise;
                    } finally {
                        signal.removeEventListener("abort", abort);
                    }
                } finally {
                    turns.delete(sessionId);
                }
            })
            .onRequest(
                "_session/steering",
                (params: unknown) => params,
                async (context) => {
                    const params = context.params;
                    if (
                        params === null ||
                        typeof params !== "object" ||
                        !("sessionId" in params) ||
                        typeof params.sessionId !== "string"
                    ) {
                        throw new Error("Invalid controlled steering request");
                    }
                    const history = sessions.get(params.sessionId);
                    if (history === undefined || !turns.has(params.sessionId)) {
                        return { outcome: "promptRequired" };
                    }
                    const count = steeringToolCounts.get(params.sessionId) ?? 1;
                    for (let index = 0; index < count; index += 1) {
                        const event: acp.SessionNotification = {
                            sessionId: params.sessionId,
                            update: {
                                sessionUpdate: "tool_call",
                                toolCallId: crypto.randomUUID(),
                                title: count === 1 ? "Steered verification" : `Steered verification ${index + 1}`,
                                status: "in_progress",
                                kind: "other",
                            },
                        };
                        history.push(event);
                        await context.client.notify(acp.methods.client.session.update, event);
                    }
                    const turn = turns.get(params.sessionId);
                    if (heldSteering.has(params.sessionId) && turn !== undefined) {
                        const signal = AbortSignal.any([context.signal, lifetime.signal, turn.signal]);
                        const finished = Promise.withResolvers<void>();
                        const abort = () => finished.resolve();
                        signal.addEventListener("abort", abort, { once: true });
                        try {
                            if (signal.aborted) {
                                abort();
                            }
                            await finished.promise;
                        } finally {
                            signal.removeEventListener("abort", abort);
                        }
                    }
                    return { outcome: "injected" };
                },
            )
            .onNotification(acp.methods.agent.session.cancel, (context) => turns.get(context.params.sessionId)?.abort())
            .onRequest(acp.methods.agent.session.close, (context) => {
                turns.get(context.params.sessionId)?.abort();
                return {};
            });
        return {
            app: () => app,
            terminated: termination.promise,
            initialize: async (signal) => signal.throwIfAborted(),
            close: async () => {
                lifetime.abort();
                termination.resolve({ kind: "closed" });
            },
        };
    };
    return new InProcessAcpAgentDefinition(
        "tool-lifecycle-test",
        "Tool Lifecycle Agent",
        process.execPath,
        createEndpoint,
        {},
        "controlled-harness",
        undefined,
        fakeDaemonCapabilities,
    );
}
