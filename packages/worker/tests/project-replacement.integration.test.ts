import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import worker from "../src/application.ts";
import { computerObject } from "../src/gateway/computer-object-routing.ts";
import { APP_ORIGIN, createIdentityFixture } from "./support/identity-fixture.ts";

const replacementSchema = v.object({
    bot: v.object({ botId: v.string(), displayName: v.string() }),
    computerId: v.string(),
    // Independently retained setup decoder from main at 81157fb4: no new token format is required.
    token: v.pipe(v.string(), v.regex(/^morty_anon_v1_[A-Za-z0-9_-]{43}$/u)),
    userId: v.string(),
});

let fixture: Awaited<ReturnType<typeof createIdentityFixture>>;

beforeAll(async () => {
    fixture = await createIdentityFixture({
        workerEntryPoint: fileURLToPath(new URL("./support/credential-storage-worker.ts", import.meta.url)),
    });
});

afterAll(async () => {
    await fixture.close();
});

test("Given a saved Machine on a Project, When its Project is replaced, Then the same user receives a fresh Project, Machine, and credential", async () => {
    const environment = fixture.environment();
    const original = await fixture.createAnonymousUser();
    const replace = async () =>
        await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/computers/${original.computerId}/management/computer/replacement`, {
                method: "POST",
                headers: { authorization: `Bearer ${original.token}` },
            }),
            environment,
        );

    const response = await replace();
    expect(response.status).toBe(201);
    const replacement = v.parse(replacementSchema, await response.json());
    expect(replacement.userId).toBe(original.userId);
    expect(replacement.computerId).not.toBe(original.computerId);
    expect(replacement.token).not.toBe(original.token);

    const retryResponse = await replace();
    expect(retryResponse.status).toBe(201);
    const retry = v.parse(replacementSchema, await retryResponse.json());
    expect(retry.computerId).toBe(replacement.computerId);
    expect(retry.bot.botId).toBe(replacement.bot.botId);
    expect(retry.token).toBe(replacement.token);

    const sessionResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${replacement.computerId}/session`, {
            headers: { authorization: `Bearer ${replacement.token}` },
        }),
        environment,
    );
    expect(sessionResponse.status).toBe(200);

    const previousCredential = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${replacement.computerId}/session`, {
            headers: { authorization: `Bearer ${original.token}` },
        }),
        environment,
    );
    expect(previousCredential.status).toBe(401);

    const bindingResponse = await worker.fetch(
        new Request(
            `${APP_ORIGIN}/morty/api/computers/${replacement.computerId}/management/bots/${replacement.bot.botId}/runtime-binding`,
            { headers: { authorization: `Bearer ${replacement.token}` } },
        ),
        environment,
    );
    expect(bindingResponse.status).toBe(200);
    expect(await bindingResponse.json()).toMatchObject({ botId: replacement.bot.botId, computerId: null });
});

test("Given a revoked successor local credential, When the previous Machine retries replacement, Then it cannot reactivate that credential", async () => {
    const original = await fixture.createAnonymousUser();
    const replace = () =>
        worker.fetch(
            projectRequest(original.computerId, "/management/computer/replacement", original.token, "POST"),
            fixture.environment(),
        );
    const response = await replace();
    expect(response.status).toBe(201);
    const replacement = v.parse(replacementSchema, await response.json());
    expect(
        (
            await worker.fetch(
                projectRequest(replacement.computerId, "/identity/v1/local-credential", replacement.token, "DELETE"),
                fixture.environment(),
            )
        ).status,
    ).toBe(204);
    const retry = await replace();
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: "LOCAL_CREDENTIAL_UNAVAILABLE" } });
    expect(
        (
            await worker.fetch(
                projectRequest(replacement.computerId, "/session", replacement.token),
                fixture.environment(),
            )
        ).status,
    ).toBe(401);
});

function projectRequest(computerId: string, path: string, token: string, method = "GET", body?: object): Request {
    return new Request(`${APP_ORIGIN}/morty/api/computers/${computerId}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

test("Given bootstrap persisted only its local credential, When the saved Machine retries replacement, Then setup receives that credential and a completed Machine", async () => {
    const original = await fixture.createAnonymousUser();
    const replace = () =>
        worker.fetch(
            projectRequest(original.computerId, "/management/computer/replacement", original.token, "POST"),
            fixture.environment(),
        );
    const response = await replace();
    expect(response.status).toBe(201);
    const issued = v.parse(replacementSchema, await response.json());
    const storage = computerObject(fixture.environment(), issued.computerId);
    expect(
        (await storage.fetch(new Request("https://computer.internal/incomplete-bootstrap", { method: "DELETE" })))
            .status,
    ).toBe(204);
    expect(
        (await worker.fetch(projectRequest(issued.computerId, "/session", issued.token), fixture.environment())).status,
    ).toBe(401);

    // Reload the real Worker with its durable storage intact before resuming the incomplete bootstrap.
    await fixture.changePlatformOrigin(fixture.baseConfiguration.MORTY_RELAY_URL);

    const retry = await replace();
    expect(retry.status).toBe(201);
    const completed = v.parse(replacementSchema, await retry.json());
    expect(completed.token).toBe(issued.token);
    expect(completed.computerId).toBe(issued.computerId);
    expect(
        (await worker.fetch(projectRequest(completed.computerId, "/session", completed.token), fixture.environment()))
            .status,
    ).toBe(200);
    expect(
        (
            await worker.fetch(
                projectRequest(
                    completed.computerId,
                    `/management/bots/${completed.bot.botId}/runtime-binding`,
                    completed.token,
                ),
                fixture.environment(),
            )
        ).status,
    ).toBe(200);
});

async function share(computerId: string, token: string): Promise<string> {
    const response = await worker.fetch(
        projectRequest(computerId, "/identity/transfers", token, "POST", { operationId: crypto.randomUUID() }),
        fixture.environment(),
    );
    expect(response.status).toBe(201);
    return new URL(v.parse(v.object({ url: v.string() }), await response.json()).url).hash.slice("#code=".length);
}

async function redeem(code: string): Promise<Response> {
    return await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code }),
        }),
        fixture.environment(),
    );
}

test("Given access shared from a saved Machine, When its Project is replaced, Then nothing shared before opens the previous Project and the local identity can still repeat the replacement", async () => {
    const original = await fixture.createAnonymousUser();
    const redeemed = await redeem(await share(original.computerId, original.token));
    expect(redeemed.status).toBe(200);
    const browser = v.parse(v.object({ token: v.string() }), await redeemed.json()).token;
    const recoveryResponse = await worker.fetch(
        projectRequest(original.computerId, "/identity/recovery-token", original.token, "POST"),
        fixture.environment(),
    );
    expect(recoveryResponse.status).toBe(201);
    const recovery = v.parse(v.object({ token: v.string() }), await recoveryResponse.json()).token;
    const unredeemed = await share(original.computerId, original.token);

    const replace = async () =>
        await worker.fetch(
            projectRequest(original.computerId, "/management/computer/replacement", original.token, "POST"),
            fixture.environment(),
        );
    const response = await replace();
    expect(response.status).toBe(201);
    const replacement = v.parse(replacementSchema, await response.json());

    for (const token of [browser, recovery]) {
        expect(
            (await worker.fetch(projectRequest(original.computerId, "/session", token), fixture.environment())).status,
        ).toBe(401);
    }
    expect((await redeem(unredeemed)).status).toBe(410);
    // A reply the local identity never received can be asked for again.
    const retry = await replace();
    expect(retry.status).toBe(201);
    expect(v.parse(replacementSchema, await retry.json()).computerId).toBe(replacement.computerId);
});

test("Given a browser that opened a shared link, When it asks to replace the Project, Then only the machine's own identity may", async () => {
    const original = await fixture.createAnonymousUser();
    const redeemed = await redeem(await share(original.computerId, original.token));
    const browser = v.parse(v.object({ token: v.string() }), await redeemed.json()).token;

    const response = await worker.fetch(
        projectRequest(original.computerId, "/management/computer/replacement", browser, "POST"),
        fixture.environment(),
    );

    expect(response.status).toBe(403);
    expect(
        (await worker.fetch(projectRequest(original.computerId, "/session", original.token), fixture.environment()))
            .status,
    ).toBe(200);
});

test("Given an unauthenticated request, When a Project replacement is requested, Then it is rejected", async () => {
    const identity = await fixture.createAnonymousUser();
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/computers/${identity.computerId}/management/computer/replacement`, {
            method: "POST",
        }),
        fixture.environment(),
    );
    expect(response.status).toBe(401);
});
