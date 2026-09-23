import { MobiusClient } from "@moxt-ai/mobius-sdk";
import type { E2EHarness } from "./harness.ts";

interface RequestOptions {
    readonly body?: unknown;
    readonly project?: string;
    readonly token?: string;
    readonly provider?: string;
    readonly signal: AbortSignal;
}

interface BrowserIdentity {
    readonly botId: string;
    readonly projectId: string;
    readonly token: string;
}

export function object(value: unknown, name: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Expected ${name} to be an object`);
    }
    return Object.fromEntries(Object.entries(value));
}

export function text(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Expected ${name}`);
    }
    return value;
}

export async function jsonRequest(
    origin: string,
    path: string,
    { body, project, token, provider, signal }: RequestOptions,
) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
    }
    if (provider !== undefined) {
        headers["x-mobius-oidc-provider"] = provider;
    }
    const scopedPath =
        project !== undefined && path.startsWith("/morty/api/") && !path.startsWith("/morty/api/chat/projects/")
            ? path.replace("/morty/api/", `/morty/api/projects/${encodeURIComponent(project)}/`)
            : path;
    const response = await fetch(new URL(scopedPath, origin), {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
    });
    const raw = await response.text();
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error(`${path} returned invalid JSON (${response.status}): ${raw.slice(0, 500)}`);
    }
    if (!response.ok) {
        throw new Error(`${path} failed (${response.status}): ${raw.slice(0, 1_000)}`);
    }
    return object(value, path);
}

export class ChatApi {
    readonly origin: string;
    readonly signal: AbortSignal;
    identity: BrowserIdentity | undefined;

    constructor(origin: string, signal: AbortSignal) {
        this.origin = origin;
        this.signal = signal;
    }

    async useBrowserIdentity(value: unknown) {
        const identity = object(value, "anonymous identity");
        const projectId = text(identity.projectId, "projectId");
        const token = text(identity.token, "anonymous token");
        const directory = await jsonRequest(this.origin, "/morty/api/management/bots", {
            project: projectId,
            token,
            signal: this.signal,
        });
        if (!Array.isArray(directory.bots) || directory.bots.length !== 1) {
            throw new Error(`Expected exactly one browser bot, received ${String(directory.bots)}`);
        }
        const bot = object(directory.bots[0], "browser bot");
        this.identity = {
            botId: text(bot.botId, "botId"),
            projectId,
            token,
        };
        return this.identity;
    }

    async createPairing() {
        return await this.#request("/morty/api/management/runtime-pairings", {
            body: { idempotencyKey: crypto.randomUUID() },
        });
    }

    readonly cancelSessionTurn = async (sessionId: string, turnId: string) => {
        const identity = this.#requireIdentity();
        const access = await this.#request(
            `/morty/api/chat/projects/${encodeURIComponent(identity.projectId)}/bots/${encodeURIComponent(identity.botId)}/session-access`,
            {
                body: { sessionId },
            },
        );
        const client = new MobiusClient({
            endpoint: text(access.endpoint, "session endpoint"),
            projectId: text(access.projectId, "project ID"),
            credentialProvider: {
                credential: async (signal) => {
                    signal.throwIfAborted();
                    return text(access.credential, "credential");
                },
            },
        });
        try {
            await client.turns.cancel(sessionId, turnId, { idempotencyKey: crypto.randomUUID() }, this.signal);
        } finally {
            client.close();
        }
    };

    async waitForAgent(harness: E2EHarness, pairingId: string, agentId: string, agentLabel: string) {
        const paired = await harness.waitFor(
            `Mobius pairing with ${agentLabel}`,
            () => this.#request(`/morty/api/management/runtime-pairings/${encodeURIComponent(pairingId)}`),
            (status) =>
                status.status === "paired" &&
                Array.isArray(status.agents) &&
                status.agents.some((agent) => object(agent, "agent").id === agentId),
        );
        return { runtimeId: text(paired.runtimeId, "runtimeId") };
    }

    async bindAgent(runtimeId: string, agentId: string) {
        const identity = this.#requireIdentity();
        await this.#request(
            `/morty/api/chat/projects/${encodeURIComponent(identity.projectId)}/bots/${encodeURIComponent(identity.botId)}/setup`,
            {
                body: { runtimeId, agentRef: agentId },
            },
        );
    }

    async waitForBinding(harness: E2EHarness, agentId: string, agentLabel: string) {
        const identity = this.#requireIdentity();
        await harness.waitFor(
            `${agentLabel} Bot binding`,
            () =>
                this.#request(
                    `/morty/api/chat/projects/${encodeURIComponent(identity.projectId)}/bots/${encodeURIComponent(identity.botId)}/workspace`,
                    {
                        body: {},
                    },
                ),
            (workspace) =>
                workspace.status === "active" &&
                Array.isArray(workspace.agents) &&
                workspace.agents.some((agent) => object(agent, "agent").agentRef === agentId),
        );
    }

    #requireIdentity() {
        if (this.identity === undefined) {
            throw new Error("The browser identity has not been created");
        }
        return this.identity;
    }

    async #request(path: string, options: { readonly body?: unknown } = {}) {
        const identity = this.#requireIdentity();
        return await jsonRequest(this.origin, path, {
            ...options,
            project: identity.projectId,
            token: identity.token,
            signal: this.signal,
        });
    }
}
