function object(value, name) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Expected ${name} to be an object`);
    }
    return value;
}

export function text(value, name) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Expected ${name}`);
    }
    return value;
}

export async function jsonRequest(origin, path, { body, project, token, provider, signal } = {}) {
    const headers = { "content-type": "application/json" };
    if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
    }
    if (provider !== undefined) {
        headers["x-mobius-oidc-provider"] = provider;
    }
    if (project !== undefined) {
        headers["x-mobius-project-id"] = project;
    }
    const response = await fetch(new URL(path, origin), {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
    });
    const raw = await response.text();
    let value;
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
    constructor(origin, signal) {
        this.origin = origin;
        this.signal = signal;
    }

    async readBrowserIdentity(response) {
        const raw = await response.text();
        if (!response.ok()) {
            throw new Error(`Anonymous identity creation failed (${response.status()}): ${raw.slice(0, 1_000)}`);
        }
        const value = object(JSON.parse(raw), "anonymous identity");
        this.identity = {
            botId: text(object(value.bot, "bot").botId, "botId"),
            projectId: text(value.projectId, "projectId"),
            token: text(value.token, "anonymous token"),
        };
        return this.identity;
    }

    async createPairing() {
        return await this.#request("/mobius-cloud/api/management/runtime-pairings", {
            body: { idempotencyKey: crypto.randomUUID() },
        });
    }

    async waitForOpenCode(harness, pairingId) {
        return await harness.waitFor(
            "Mobius pairing with OpenCode",
            () => this.#request(`/mobius-cloud/api/management/runtime-pairings/${encodeURIComponent(pairingId)}`),
            (status) =>
                status.status === "paired" &&
                Array.isArray(status.agents) &&
                status.agents.some((agent) => object(agent, "agent").id === "opencode"),
        );
    }

    async bindOpenCode(runtimeId) {
        await this.#request(`/mobius-cloud/api/chat/bots/${encodeURIComponent(this.identity.botId)}/setup`, {
            body: { runtimeId, agentRef: "opencode", workspaceRef: "default", agentConfigRevision: 1 },
        });
    }

    async waitForBinding(harness) {
        await harness.waitFor(
            "OpenCode Bot binding",
            () =>
                this.#request(`/mobius-cloud/api/chat/bots/${encodeURIComponent(this.identity.botId)}/workspace`, {
                    body: {},
                }),
            (workspace) =>
                workspace.status === "active" &&
                workspace.selected !== null &&
                object(workspace.selected, "selected").agentRef === "opencode",
        );
    }

    async #request(path, options = {}) {
        if (this.identity === undefined) {
            throw new Error("The browser identity has not been created");
        }
        return await jsonRequest(this.origin, path, {
            ...options,
            project: this.identity.projectId,
            token: this.identity.token,
            signal: this.signal,
        });
    }
}
