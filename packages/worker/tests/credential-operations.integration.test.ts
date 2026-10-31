import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import worker, { fetchPublicApplication } from "../src/application.ts";
import { APP_ORIGIN, createIdentityFixture } from "./support/identity-fixture.ts";

let fixture: Awaited<ReturnType<typeof createIdentityFixture>>;
beforeAll(async () => {
    fixture = await createIdentityFixture({
        workerEntryPoint: fileURLToPath(new URL("./support/credential-storage-worker.ts", import.meta.url)),
    });
});
afterAll(async () => {
    await fixture.close();
});

test.each(["v1", "migrated"] as const)(
    "Given local, browser and recovery credentials, When their %s operations end access, Then each preserves the other credential kinds and only browser access closes its links",
    async (version) => {
        const owner = await fixture.createAnonymousUser();
        const request = (path: string, token: string, method = "GET") =>
            fetchPublicApplication(
                new Request(`${APP_ORIGIN}/morty/api/projects/${owner.projectId}${path}`, {
                    method,
                    headers: { authorization: `Bearer ${token}` },
                }),
                fixture.environment(),
            );
        const recoveryResponse = await request("/identity/recovery-token", owner.token, "POST");
        expect(recoveryResponse.status).toBe(201);
        const recovery = v.parse(v.object({ token: v.string() }), await recoveryResponse.json()).token;
        const transferResponse = await request("/identity/transfers", owner.token, "POST");
        const code = new URL(v.parse(v.object({ url: v.string() }), await transferResponse.json()).url).hash.slice(6);
        const redeem = () =>
            worker.fetch(
                new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ code }),
                }),
                fixture.environment(),
            );
        const browser = v.parse(v.object({ token: v.string() }), await (await redeem()).json()).token;
        const sibling = v.parse(v.object({ token: v.string() }), await (await redeem()).json()).token;
        const operations = [
            { token: recovery, path: "/identity/v1/recovery-credential" },
            { token: owner.token, path: "/identity/v1/local-credential" },
            { token: browser, path: "/identity/v1/browser-access" },
        ];
        const namespace = fixture.environment().CHAT_PROJECTS;
        const storage = namespace.get(namespace.idFromName(owner.projectId));
        const kinds = async (method = "GET") =>
            await (await storage.fetch(new Request("https://project.internal/credential-kinds", { method }))).json();
        expect(await kinds()).toEqual(expect.arrayContaining(["local", "browser", "recovery"]));
        if (version === "migrated") {
            expect(await kinds("DELETE")).toEqual([null, null, null, null]);
            const invalid = `${owner.token.slice(0, -1)}${owner.token.endsWith("A") ? "B" : "A"}`;
            expect((await request("/session", invalid)).status).toBe(401);
            expect(await kinds()).toEqual([null, null, null, null]);
        }
        for (const operation of operations) {
            const session = await request("/session", operation.token);
            expect(session.status).toBe(200);
            expect(session.headers.get("Morty-Credential-Revocation")).toBe(operation.path);
            for (const other of operations.filter((entry) => entry.path !== operation.path)) {
                const rejected = await request(other.path, operation.token, "DELETE");
                expect(rejected.status).toBe(403);
                expect(await rejected.json()).toMatchObject({ error: { code: "CREDENTIAL_KIND_REQUIRED" } });
            }
        }
        if (version === "migrated") {
            expect(await kinds()).toEqual(expect.arrayContaining(["local", "browser", "recovery", null]));
        }
        for (const token of [browser, recovery]) {
            expect((await request("/identity/revoke-all-access", token, "POST")).status).toBe(403);
        }
        for (const [index, operation] of operations.entries()) {
            expect((await request(operation.path, operation.token, "DELETE")).status).toBe(204);
            expect((await request("/session", operation.token)).status).toBe(401);
            expect((await request(operation.path, operation.token, "DELETE")).status).toBe(401);
            for (const remaining of operations.slice(index + 1)) {
                expect((await request("/session", remaining.token)).status).toBe(200);
            }
            expect((await request("/session", sibling)).status).toBe(index === 2 ? 401 : 200);
            expect((await redeem()).status).toBe(index === 2 ? 410 : 200);
        }
    },
);

test("Given a browser that joined through a link, When it asks for recovery access, a Runtime pairing or the Machine's binding, Then only the machine's local credential may issue them", async () => {
    const owner = await fixture.createAnonymousUser();
    const request = (path: string, token: string, method = "GET", body?: object) =>
        fetchPublicApplication(
            new Request(`${APP_ORIGIN}/morty/api${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${token}`,
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            fixture.environment(),
        );
    const project = `/projects/${owner.projectId}`;
    const botId = v.parse(
        v.object({ botId: v.string() }),
        await (await request(`${project}/management/bot`, owner.token)).json(),
    ).botId;
    const transfer = await request(`${project}/identity/transfers`, owner.token, "POST");
    const code = new URL(v.parse(v.object({ url: v.string() }), await transfer.json()).url).hash.slice(6);
    const redeemed = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code }),
        }),
        fixture.environment(),
    );
    const browser = v.parse(v.object({ token: v.string() }), await redeemed.json()).token;
    const recoveryResponse = await request(`${project}/identity/recovery-token`, owner.token, "POST");
    expect(recoveryResponse.status).toBe(201);
    const recovery = v.parse(v.object({ token: v.string() }), await recoveryResponse.json()).token;

    for (const token of [browser, recovery]) {
        for (const refused of [
            await request(`${project}/identity/recovery-token`, token, "POST"),
            await request(`${project}/management/runtime-pairings`, token, "POST", {
                idempotencyKey: "shared-pairing",
            }),
            await request(`/chat/projects/${owner.projectId}/bots/${botId}/setup`, token, "POST", {
                runtimeId: "shared-runtime",
                agentRef: "codex",
            }),
        ]) {
            expect(refused.status).toBe(403);
            expect(await refused.json()).toMatchObject({ error: { code: "LOCAL_IDENTITY_REQUIRED" } });
        }
    }
    // Shared access still shares onward, as the sharing dialog offers, and still ends itself.
    expect((await request(`${project}/identity/transfers`, browser, "POST")).status).toBe(201);
    expect((await request(`${project}/identity/v1/browser-access`, browser, "DELETE")).status).toBe(204);
    expect((await request(`${project}/session`, browser)).status).toBe(401);
});
