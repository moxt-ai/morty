import * as acp from "@agentclientprotocol/sdk";
import {
    type AcpEndpointTermination,
    InProcessAcpAgentDefinition,
    type InProcessAcpEndpoint,
} from "@moxt-ai/mobius/runtime";
import { fakeDaemonCapabilities } from "@moxt-ai/mobius-test-support/fake-daemon";

/** A stateful ACP peer injected through the production daemon's Agent port. */
export function createInteractionAgent() {
    const sessions = new Set<string>();
    const createEndpoint = (): InProcessAcpEndpoint => {
        const termination = Promise.withResolvers<AcpEndpointTermination>();
        const lifetime = new AbortController();
        const turns = new Map<string, AbortController>();
        const app = acp
            .agent({ name: "morty-interaction-agent" })
            .onRequest(acp.methods.agent.initialize, () => ({
                agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, list: {}, resume: {} } },
                agentInfo: { name: "Interaction Agent", version: "controlled-harness" },
                authMethods: [],
                protocolVersion: acp.PROTOCOL_VERSION,
            }))
            .onRequest(acp.methods.agent.session.new, () => {
                const sessionId = crypto.randomUUID();
                sessions.add(sessionId);
                return { sessionId, configOptions: [] };
            })
            .onRequest(acp.methods.agent.session.load, () => ({ configOptions: [] }))
            .onRequest(acp.methods.agent.session.resume, () => ({ configOptions: [] }))
            .onRequest(acp.methods.agent.session.list, () => ({ sessions: [] }))
            .onRequest(acp.methods.agent.session.prompt, async (context) => {
                const sessionId = context.params.sessionId;
                if (!sessions.has(sessionId)) {
                    throw new Error("Unknown controlled session");
                }
                const cancellation = new AbortController();
                turns.set(sessionId, cancellation);
                const signal = AbortSignal.any([lifetime.signal, context.signal, cancellation.signal]);
                const longPermission = context.params.prompt.some(
                    (content) => content.type === "text" && content.text === "request long permission",
                );
                const longPath = `/workspace/${"long-directory-".repeat(12)}/src/index.ts`;
                const planMode = context.params.prompt.some(
                    (content) => content.type === "text" && content.text === "request plan mode",
                );
                const sessionScope = context.params.prompt.some(
                    (content) => content.type === "text" && content.text === "request session permission",
                );
                const options: acp.PermissionOption[] = sessionScope
                    ? [
                          { optionId: "allow-session", kind: "allow_always", name: "Allow for this session" },
                          { optionId: "deny-session", kind: "reject_always", name: "Deny for this session" },
                      ]
                    : planMode
                      ? [
                            { optionId: "allow-once", kind: "allow_once", name: "Yes, enter plan mode" },
                            { optionId: "reject", kind: "reject_once", name: "No, start implementing now" },
                        ]
                      : [
                            {
                                optionId: "allow-once",
                                kind: "allow_once",
                                name: longPermission ? `Allow reading ${longPath} for this session` : "Yes",
                            },
                            { optionId: "reject", kind: "reject_once", name: "No" },
                        ];
                try {
                    const permission = await context.client.request(
                        acp.methods.client.session.requestPermission,
                        {
                            sessionId,
                            toolCall: {
                                toolCallId: crypto.randomUUID(),
                                kind: planMode ? "switch_mode" : "execute",
                                status: "pending",
                                title: planMode
                                    ? "Enter plan mode"
                                    : longPermission
                                      ? `Read ${longPath}`
                                      : "Run verification",
                                rawInput: planMode
                                    ? { mode: "plan" }
                                    : context.params.prompt.some(
                                            (content) =>
                                                content.type === "text" &&
                                                content.text === "request without tool input",
                                        )
                                      ? undefined
                                      : { command: "pnpm test -- --reporter=verbose", target: "src/<entry>.ts" },
                                locations: planMode ? [] : [{ path: "src/<entry>.ts", line: 12 }],
                            },
                            options,
                        },
                        { cancellationSignal: signal },
                    );
                    let text = "Permission cancelled";
                    if (permission.outcome.outcome === "selected") {
                        if (sessionScope) {
                            text = `Selected decision: ${permission.outcome.optionId}`;
                        } else if (permission.outcome.optionId === "reject") {
                            text = planMode ? "Selected decision: No, start implementing now" : "Permission rejected";
                        } else {
                            const input = await context.client.request(
                                acp.methods.client.elicitation.create,
                                {
                                    sessionId,
                                    mode: "form",
                                    message: "Choose a branch to verify",
                                    requestedSchema: {
                                        type: "object",
                                        properties: { branch: { type: "string", title: "Branch", minLength: 1 } },
                                        required: ["branch"],
                                    },
                                },
                                { cancellationSignal: signal },
                            );
                            text = `Input ${input.action}`;
                            if (
                                input.action === "accept" &&
                                typeof input.content === "object" &&
                                input.content !== null &&
                                !Array.isArray(input.content)
                            ) {
                                const branch = Reflect.get(input.content, "branch");
                                if (typeof branch === "string") {
                                    text = `Selected branch: ${branch}`;
                                }
                            }
                        }
                    }
                    await context.client.notify(acp.methods.client.session.update, {
                        sessionId,
                        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
                    });
                    return { stopReason: "end_turn" };
                } catch (cause) {
                    if (signal.aborted) {
                        return { stopReason: "cancelled" };
                    }
                    throw cause;
                } finally {
                    turns.delete(sessionId);
                }
            })
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
        "interaction-test",
        "Interaction Agent",
        process.execPath,
        createEndpoint,
        {},
        "controlled-harness",
        undefined,
        fakeDaemonCapabilities,
    );
}
