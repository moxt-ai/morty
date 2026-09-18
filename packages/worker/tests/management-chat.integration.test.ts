import { Hono } from "hono";
import * as v from "valibot";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../src/application.ts";
import { InMemoryD1Database } from "./infra/database.ts";
import { createMobiusPlatformFixture } from "./infra/mobius.ts";
import { APP_ORIGIN, AUTH_TIME, clerk as issuer } from "./support/clerk.ts";

const cleanup: Array<() => void | Promise<void>> = [];
const projectSchema = v.object({ project: v.object({ projectId: v.string(), displayName: v.string() }) });
const botsSchema = v.object({ bots: v.array(v.object({ botId: v.string(), displayName: v.string() })) });

// These scenarios include a real local Platform runtime startup and D1 migrations.
vi.setConfig({ testTimeout: 15_000 });

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

async function fixture(location?: string) {
    const mobius = await createMobiusPlatformFixture();
    cleanup.push(mobius.close);
    const database = new InMemoryD1Database();
    cleanup.push(database.close);
    const baseBindings = {
        APP_ORIGIN,
        CLERK_JWT_KEY: issuer.publicKey,
        CLERK_PUBLISHABLE_KEY: issuer.publishableKey,
        CHAT_ATTACHMENTS_APAC: mobius.attachments,
        CHAT_ATTACHMENTS_WNAM: mobius.attachments,
        MOBIUS_APP_ID: mobius.appId,
        MOBIUS_APP_SECRET: mobius.appCredential,
        MOBIUS_BASE_URL: mobius.baseUrl,
    };
    const projectObjects = {
        idFromName: (name: string) => name,
        get: (projectId: string) => ({
            fetch: (request: Request) =>
                worker.fetch(request, {
                    ...baseBindings,
                    CHAT_PROJECT_ID: projectId,
                    DATABASE: database,
                    ATTACHMENTS: mobius.attachments,
                }),
        }),
    };
    const bindings = { ...baseBindings, CHAT_PROJECTS: projectObjects };
    const app = new Hono().all("*", (context) => {
        if (location !== undefined) {
            Object.defineProperty(context.req.raw, "cf", { value: { continent: location === "wnam" ? "NA" : "AS" } });
        }
        return worker.fetch(context.req.raw, bindings);
    });
    const projects = new Map<string, string>();
    const request = (path: string, token: string, method = "GET", body?: object) =>
        app.request(
            `https://cloud.test/mobius-cloud/api/${path.startsWith("chat/") ? path.replace("chat/", `chat/projects/${projects.get(token) ?? "missing"}/`) : projects.has(token) ? `projects/${projects.get(token)}/${path}` : path}`,
            {
                method,
                headers: {
                    authorization: `Bearer ${token}`,
                    "content-type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
        );
    const anonymous = async () => {
        const response = await app.request("https://cloud.test/mobius-cloud/api/identity/anonymous-users", {
            method: "POST",
        });
        expect(response.status).toBe(201);
        const identity = v.parse(v.object({ token: v.string(), projectId: v.string() }), await response.json());
        projects.set(identity.token, identity.projectId);
        return identity.token;
    };
    return { app, mobius, request, anonymous, bindings, database };
}

test.each(["apac", "wnam"])(
    "Given a Project Durable Object in %s, When its session is read at the edge, Then the object authenticates it without shared database storage",
    async (region) => {
        const fixture = await fixtureForProjectObject(region);
        const edge = {
            ...fixture.bindings,
            DATABASE: undefined,
            CHAT_PROJECTS: fixture.projects,
        };
        const request = (token: string) =>
            new Request(`https://cloud.test/mobius-cloud/api/projects/${fixture.projectId}/session`, {
                headers: { authorization: `Bearer ${token}` },
            });
        expect((await worker.fetch(request(fixture.token), edge)).status).toBe(200);
        expect((await worker.fetch(request("mobius_anon_invalid"), edge)).status).toBe(401);
    },
);

async function fixtureForProjectObject(region: string) {
    const value = await fixture(region);
    const created = await value.app.request("https://cloud.test/mobius-cloud/api/identity/anonymous-users", {
        method: "POST",
    });
    const identity = v.parse(v.object({ token: v.string(), projectId: v.string() }), await created.json());
    const projects = {
        idFromName: (name: string) => name,
        get: (projectId: string) => ({
            fetch: (request: Request) =>
                worker.fetch(request, {
                    ...value.bindings,
                    CHAT_PROJECT_ID: projectId,
                    DATABASE: value.database,
                    ATTACHMENTS: projectId.startsWith("prj_a")
                        ? value.bindings.CHAT_ATTACHMENTS_APAC
                        : value.bindings.CHAT_ATTACHMENTS_WNAM,
                }),
        }),
    };
    return { ...value, token: identity.token, projectId: identity.projectId, projects };
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
    const upstream = await mobius.app.request(`/mobius/api/dashboard/v1/apps/${mobius.appId}/projects`, {
        headers: { authorization: `Bearer ${mobius.developerToken}`, "x-mobius-oidc-provider": "clerk" },
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

test("Given a user-owned Chat Bot, When its profile and instructions are managed, Then changes persist and another user cannot access them", async () => {
    const { request, anonymous } = await fixture();
    const alice = await anonymous();
    const bob = await anonymous();
    const created = v.parse(
        v.object({ botId: v.string(), displayName: v.string() }),
        await (await request("management/bots", alice, "POST", { displayName: "Research Bot" })).json(),
    );
    const { bots } = v.parse(botsSchema, await (await request("management/bots", alice)).json());
    expect(bots).toContainEqual(created);
    expect((await request(`management/bots/${created.botId}`, bob)).status).toBe(404);
    const updated = await request(`management/bots/${created.botId}`, alice, "PATCH", {
        displayName: "Research Assistant",
        instructions: "Cite the source for every factual claim.",
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
        botId: created.botId,
        configured: false,
        displayName: "Research Assistant",
        instructions: "Cite the source for every factual claim.",
    });
    expect(await (await request(`management/bots/${created.botId}`, alice)).json()).toEqual({
        botId: created.botId,
        configured: false,
        displayName: "Research Assistant",
        instructions: "Cite the source for every factual claim.",
    });
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
        const invalid = await app.request(
            `https://cloud.test/mobius-cloud/api/projects/${project.projectId}/management/project`,
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${alice}`,
                    "content-type": "application/json",
                },
                body,
            },
        );
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    }
    const nonJson = await app.request(
        `https://cloud.test/mobius-cloud/api/projects/${project.projectId}/management/project`,
        {
            method: "POST",
            headers: { authorization: `Bearer ${alice}`, "content-type": "text/plain" },
            body: JSON.stringify({ displayName: "My Project" }),
        },
    );
    expect(nonJson.status).toBe(400);
    expect(await nonJson.json()).toEqual({
        error: { code: "INVALID_REQUEST", message: "A JSON request is required." },
    });
});
