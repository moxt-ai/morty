import { Hono } from "hono";
import * as v from "valibot";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../src/application.ts";
import { InMemoryD1Database } from "./infra/database.ts";
import { createMobiusPlatformFixture } from "./infra/mobius.ts";
import { APP_ORIGIN, AUTH_TIME, IdentityProvider } from "./support/identity-provider.ts";

const issuer = new IdentityProvider();
const cleanup: Array<() => void | Promise<void>> = [];
const projectSchema = v.object({ project: v.object({ projectId: v.string(), displayName: v.string() }) });
const botsSchema = v.object({ bots: v.array(v.object({ botId: v.string(), displayName: v.string() })) });

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AUTH_TIME);
});
afterEach(async () => {
    try {
        for (const close of cleanup.splice(0).reverse()) {
            await close();
        }
    } finally {
        vi.useRealTimers();
    }
});

async function fixture() {
    const mobius = await createMobiusPlatformFixture();
    cleanup.push(mobius.close);
    const database = new InMemoryD1Database();
    cleanup.push(database.close);
    const bindings = {
        APP_ORIGIN,
        CLERK_JWT_KEY: issuer.publicKey,
        CLERK_PUBLISHABLE_KEY: issuer.publishableKey,
        DATABASE: database,
        CHAT_DATABASE_APAC: database,
        CHAT_DATABASE_WNAM: database,
        CHAT_ATTACHMENTS_APAC: mobius.attachments,
        CHAT_ATTACHMENTS_WNAM: mobius.attachments,
        MOBIUS_APP_ID: mobius.appId,
        MOBIUS_APP_SECRET: mobius.appCredential,
        MOBIUS_BASE_URL: mobius.baseUrl,
        MOBIUS_PROJECT_LOCATION_HINT: "apac",
    };
    const app = new Hono().all("*", (context) => worker.fetch(context.req.raw, bindings));
    const projects = new Map<string, string>();
    const request = (path: string, token: string, method = "GET", body?: object) =>
        app.request(`https://cloud.test/mobius-cloud/api/${path}`, {
            method,
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                ...(projects.has(token) ? { "X-Mobius-Project-Id": projects.get(token) ?? "" } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const anonymous = async () => {
        const response = await app.request("https://cloud.test/mobius-cloud/api/identity/anonymous-users", {
            method: "POST",
        });
        expect(response.status).toBe(201);
        const identity = v.parse(v.object({ token: v.string(), projectId: v.string() }), await response.json());
        projects.set(identity.token, identity.projectId);
        return identity.token;
    };
    return { app, mobius, request, anonymous };
}

test("Given an anonymous user, When they provision a Platform Project and reload, Then their Project and Bot persist and are isolated from other users", async () => {
    const { mobius, request, anonymous } = await fixture();
    const alice = await anonymous();
    const bob = await anonymous();
    const created = await request("management/project", alice, "POST", { displayName: "My Project" });
    expect(created.status).toBe(200);
    const project = v.parse(projectSchema, await created.json()).project;
    expect(project.displayName).toBe("Personal workspace");
    expect(await (await request("management/project", alice)).json()).toEqual({ project });
    expect(await (await request("management/project", alice, "POST", { displayName: "My Project" })).json()).toEqual({
        project,
    });
    const other = v.parse(projectSchema, await (await request("management/project", bob)).json()).project;
    expect(other.projectId).not.toBe(project.projectId);
    const upstream = await mobius.app.request(`/mobius/api/v1/apps/${mobius.appId}/projects`, {
        headers: { authorization: "Bearer developer-token", "x-mobius-oidc-provider": "clerk" },
    });
    expect(upstream.status).toBe(200);
    expect(await upstream.json()).toMatchObject({
        projects: expect.arrayContaining([expect.objectContaining(project)]),
    });

    const pairingResponse = await request("management/runtime-pairings", alice, "POST", {
        idempotencyKey: "local-machine",
    });
    expect(pairingResponse.status).toBe(201);
    const pairing = v.parse(
        v.object({
            pairingId: v.string(),
            projectId: v.string(),
            runtimeId: v.string(),
            pairingCode: v.string(),
            relayUrl: v.string(),
        }),
        await pairingResponse.json(),
    );
    expect(pairing).toMatchObject({ projectId: project.projectId, relayUrl: mobius.baseUrl });
    expect(pairing.pairingCode.length).toBeGreaterThan(0);
    expect(
        await (await request("management/runtime-pairings", alice, "POST", { idempotencyKey: "local-machine" })).json(),
    ).toMatchObject(pairing);
    expect(await (await request(`management/runtime-pairings/${pairing.pairingId}`, alice)).json()).toMatchObject({
        status: "pending",
    });
    expect((await request(`management/runtime-pairings/${pairing.pairingId}`, bob)).status).toBe(404);
});

test("Given a signed-in user, When they open their workspace and reload, Then a Platform Bot is provisioned for them and other users receive their own Bot", async () => {
    const { request, mobius } = await fixture();
    const alice = issuer.createSession("user_alice");
    const bob = issuer.createSession("user_bob");
    const response = await request("management/bots", alice);
    expect(response.status).toBe(200);
    const { bots } = v.parse(botsSchema, await response.json());
    expect(bots).toHaveLength(1);
    expect(await (await request("management/bots", alice)).json()).toEqual({ bots });
    const other = v.parse(botsSchema, await (await request("management/bots", bob)).json());
    expect(other.bots).toHaveLength(1);
    expect(other.bots).not.toEqual(bots);
    const project = v.parse(projectSchema, await (await request("management/project", alice)).json()).project;
    const persisted = await mobius.app.request(`/mobius/api/v1/projects/${project.projectId}/bots`, {
        headers: { authorization: `Bearer ${mobius.appCredential}` },
    });
    expect(persisted.status).toBe(200);
    expect(await persisted.json()).toMatchObject({ bots });
});

test("Given a user-owned Platform Bot, When session records are managed, Then changes persist and another user cannot access or delete them", async () => {
    const { request, anonymous } = await fixture();
    const alice = await anonymous();
    const bob = await anonymous();
    const { bots } = v.parse(botsSchema, await (await request("management/bots", alice)).json());
    const bot = bots[0];
    if (bot === undefined) {
        throw new Error("Expected a provisioned Bot");
    }
    const input = { botId: bot.botId, sessionId: "session-one", title: "Planning" };
    expect((await request("chat/sessions", bob, "POST", input)).status).toBe(404);
    expect((await request("chat/sessions", alice, "POST", input)).status).toBe(201);
    expect((await request("chat/sessions/session-one", alice, "PATCH", { title: "Project planning" })).status).toBe(
        200,
    );
    expect(await (await request("chat/sessions", alice)).json()).toEqual({
        sessions: [{ ...input, title: "Project planning" }],
    });
    expect(await (await request("chat/sessions", bob)).json()).toEqual({ sessions: [] });
    expect((await request("chat/sessions/session-one", bob, "DELETE")).status).toBe(404);
    expect((await request("chat/sessions/session-one", alice, "DELETE")).status).toBe(204);
    expect(await (await request("chat/sessions", alice)).json()).toEqual({ sessions: [] });
    for (const operation of ["access", "workspace", "native-sessions", "session-access"]) {
        expect(
            (await request(`chat/bots/${bot.botId}/${operation}`, bob, "POST", { runtimeId: "runtime-1" })).status,
        ).toBe(404);
    }
    expect((await request(`chat/bots/${bot.botId}/access`, alice, "POST")).status).toBe(409);
});

test("Given a workspace, When unauthenticated or malformed setup requests arrive, Then the HTTP boundary rejects them", async () => {
    const { request, app, anonymous } = await fixture();
    const alice = await anonymous();
    const { project } = v.parse(projectSchema, await (await request("management/project", alice)).json());
    expect((await request("management/project", "invalid-token", "POST", { displayName: "Project" })).status).toBe(401);
    for (const body of [
        "{",
        JSON.stringify({ displayName: "My Project", appId: "another-app" }),
        JSON.stringify({ displayName: "My Project", userId: "another-user" }),
    ]) {
        const invalid = await app.request("https://cloud.test/mobius-cloud/api/management/project", {
            method: "POST",
            headers: {
                authorization: `Bearer ${alice}`,
                "content-type": "application/json",
                "X-Mobius-Project-Id": project.projectId,
            },
            body,
        });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    }
});
