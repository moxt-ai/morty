import * as v from "valibot";
import type { MobiusTransport } from "../../../src/gateway/mobius-gateway";

// Stateful external Bot service: grants, credentials, conversations and accepted turns.
export class InMemoryMobius implements MobiusTransport {
    readonly runs: {
        readonly botId: string;
        readonly clientMessageId: string;
        readonly conversationId: string;
        readonly prompt: string;
    }[] = [];
    readonly results = new Map<string, string>();
    readonly #grants = new Map<
        string,
        { readonly secret: string; readonly botId: string; readonly principal: string }
    >();
    readonly #connections = new Map<string, { readonly botId: string; readonly credential: string }>();
    readonly #conversations = new Map<string, { readonly botId: string; readonly connectionId: string }>();
    readonly #targets = new Map<string, string>();
    readonly #approvedTargets = new Set<string>();
    readonly #owners = new Map<string, string>();
    responseText = "Investigation complete";
    connectionState: "connected" | "disconnect-after-result" = "connected";
    #gate: { readonly started: () => void; readonly completed: Promise<void> } | null = null;
    readonly pauseNext = () => {
        let started: () => void = () => undefined;
        let complete: () => void = () => undefined;
        const startedPromise = new Promise<void>((resolve) => {
            started = resolve;
        });
        const completed = new Promise<void>((resolve) => {
            complete = resolve;
        });
        this.#gate = { started, completed };
        return { started: startedPromise, complete };
    };
    readonly ownBot = (botId: string) => {
        const ownerCredential = crypto.randomUUID();
        this.#owners.set(botId, ownerCredential);
        return { botId, ownerCredential };
    };
    readonly issueGrant = (botId: string, principal: string) => {
        const grantId = crypto.randomUUID();
        const grantSecret = "s".repeat(32);
        this.#grants.set(grantId, { secret: grantSecret, botId, principal });
        return { botId, grantId, grantSecret };
    };
    readonly request = async (path: string, init?: RequestInit): Promise<Response> => {
        const signal = init?.signal ?? new AbortController().signal;
        signal.throwIfAborted();
        const url = new URL(path, "https://mobius.test");
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        const token = new Headers(init?.headers).get("Authorization")?.slice(7);
        if (url.pathname === "/mobius/api/v1/projects") {
            return Response.json({
                projects:
                    this.#owners.size === 0 ? [] : [{ projectId: "standalone-project", displayName: "Standalone" }],
            });
        }
        if (url.pathname === "/mobius/api/v1/projects/standalone-project/bots") {
            return Response.json({
                bots: [...this.#owners.keys()].map((botId) => ({ botId, displayName: botId, lifecycle: "draft" })),
            });
        }
        const botId = url.pathname.match(/^\/mobius\/api\/v1\/bots\/([^/]+)/u)?.[1];
        if (botId && url.pathname.endsWith("/connection-grants")) {
            if (this.#owners.get(botId) !== token) {
                return new Response(null, { status: 403 });
            }
            const input = v.parse(v.object({ label: v.string() }), body);
            return Response.json(this.issueGrant(botId, input.label));
        }
        if (botId && url.pathname.endsWith("/approve")) {
            if (this.#owners.get(botId) !== token) {
                return new Response(null, { status: 403 });
            }
            const targetId = url.pathname.split("/").at(-2);
            if (!targetId || !this.#targets.has(targetId)) {
                return new Response(null, { status: 404 });
            }
            this.#approvedTargets.add(targetId);
            return Response.json({ deliveryTargetId: targetId });
        }
        if (url.pathname === "/mobius/api/v1/bot-connection-grants/redeem") {
            const input = v.parse(
                v.object({
                    audience: v.literal("slack"),
                    connectorPrincipalId: v.string(),
                    grantId: v.string(),
                    grantSecret: v.string(),
                }),
                body,
            );
            const grant = this.#grants.get(input.grantId);
            if (!grant || grant.secret !== input.grantSecret || grant.principal !== input.connectorPrincipalId) {
                return new Response(null, { status: 403 });
            }
            this.#grants.delete(input.grantId);
            const connectionId = crypto.randomUUID();
            const credential = crypto.randomUUID();
            this.#connections.set(connectionId, { botId: grant.botId, credential });
            return Response.json({
                botId: grant.botId,
                connectionId,
                credential,
                audience: input.audience,
                connectorPrincipalId: input.connectorPrincipalId,
                lifecycle: "active",
                scopes: ["inbound-conversation:create", "inbound-message:create", "conversation-events:read"],
            });
        }
        const connection = [...this.#connections].find(([, value]) => value.credential === token);
        if (!connection) {
            return new Response(null, { status: 401 });
        }
        const [connectionId, access] = connection;
        if (url.pathname === `/mobius/api/v1/bot-connections/${connectionId}/revoke`) {
            this.#connections.delete(connectionId);
            return Response.json({ connectionId, lifecycle: "revoked" });
        }
        if (url.pathname === `/mobius/api/v1/bot-connections/${connectionId}/delivery-targets`) {
            const target = crypto.randomUUID();
            this.#targets.set(target, connectionId);
            return Response.json({ deliveryTargetId: target });
        }
        const prefix = `/mobius/api/v1/bots/${access.botId}/conversations`;
        if (url.pathname === prefix) {
            const input = v.parse(v.object({ replyDeliveryTargetId: v.string() }), body);
            if (
                this.#targets.get(input.replyDeliveryTargetId) !== connectionId ||
                !this.#approvedTargets.has(input.replyDeliveryTargetId)
            ) {
                return new Response(null, { status: 403 });
            }
            const conversationId = crypto.randomUUID();
            this.#conversations.set(conversationId, { botId: access.botId, connectionId });
            return Response.json({ conversationId });
        }
        const conversationId = url.pathname.slice(prefix.length + 1).split("/")[0];
        if (!conversationId || this.#conversations.get(conversationId)?.connectionId !== connectionId) {
            return new Response(null, { status: 404 });
        }
        if (url.pathname === `${prefix}/${conversationId}/messages`) {
            const input = v.parse(v.object({ clientMessageId: v.string(), text: v.string() }), body);
            if (!this.results.has(input.clientMessageId)) {
                this.runs.push({
                    botId: access.botId,
                    clientMessageId: input.clientMessageId,
                    conversationId,
                    prompt: input.text,
                });
                const gate = this.#gate;
                this.#gate = null;
                if (gate !== null) {
                    gate.started();
                    await waitForGate(gate.completed, signal);
                }
                this.results.set(input.clientMessageId, this.responseText);
                if (this.connectionState === "disconnect-after-result") {
                    this.connectionState = "connected";
                    throw new TypeError("Connection closed");
                }
            }
            return Response.json({ turnId: input.clientMessageId });
        }
        if (url.pathname === `${prefix}/${conversationId}/events`) {
            return Response.json({
                cursor: "end",
                hasMore: false,
                events: this.runs
                    .filter((run) => run.conversationId === conversationId)
                    .flatMap((run) => [
                        {
                            turnId: run.clientMessageId,
                            kind: "agent.message.delta",
                            payload: { text: this.results.get(run.clientMessageId) },
                        },
                        { turnId: run.clientMessageId, kind: "session.completed", payload: { stopReason: "end_turn" } },
                    ]),
            });
        }
        return new Response(null, { status: 404 });
    };
}

async function waitForGate(completed: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const aborted = () => {
            signal.removeEventListener("abort", aborted);
            reject(signal.reason);
        };
        signal.addEventListener("abort", aborted, { once: true });
        void completed.then(() => {
            signal.removeEventListener("abort", aborted);
            resolve();
        }, reject);
    });
    signal.throwIfAborted();
}
