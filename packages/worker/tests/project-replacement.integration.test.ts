import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import worker from "../src/application.ts";
import { APP_ORIGIN, createIdentityFixture } from "./support/identity-fixture.ts";

const replacementSchema = v.object({
    bot: v.object({ botId: v.string(), displayName: v.string() }),
    projectId: v.string(),
    token: v.string(),
    userId: v.string(),
});

let fixture: Awaited<ReturnType<typeof createIdentityFixture>>;

beforeAll(async () => {
    fixture = await createIdentityFixture();
});

afterAll(async () => {
    await fixture.close();
});

test("Given a saved Machine on a Project, When its Project is replaced, Then the same user receives a fresh Project, Machine, and credential", async () => {
    const environment = fixture.environment();
    const original = await fixture.createAnonymousUser();
    const replace = async () =>
        await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/projects/${original.projectId}/management/project/replacement`, {
                method: "POST",
                headers: { authorization: `Bearer ${original.token}` },
            }),
            environment,
        );

    const response = await replace();
    expect(response.status).toBe(201);
    const replacement = v.parse(replacementSchema, await response.json());
    expect(replacement.userId).toBe(original.userId);
    expect(replacement.projectId).not.toBe(original.projectId);
    expect(replacement.token).not.toBe(original.token);

    const retryResponse = await replace();
    expect(retryResponse.status).toBe(201);
    const retry = v.parse(replacementSchema, await retryResponse.json());
    expect(retry.projectId).toBe(replacement.projectId);
    expect(retry.bot.botId).toBe(replacement.bot.botId);

    const sessionResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/projects/${replacement.projectId}/session`, {
            headers: { authorization: `Bearer ${replacement.token}` },
        }),
        environment,
    );
    expect(sessionResponse.status).toBe(200);

    const previousCredential = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/projects/${replacement.projectId}/session`, {
            headers: { authorization: `Bearer ${original.token}` },
        }),
        environment,
    );
    expect(previousCredential.status).toBe(401);

    const bindingResponse = await worker.fetch(
        new Request(
            `${APP_ORIGIN}/morty/api/projects/${replacement.projectId}/management/bots/${replacement.bot.botId}/runtime-binding`,
            { headers: { authorization: `Bearer ${replacement.token}` } },
        ),
        environment,
    );
    expect(bindingResponse.status).toBe(200);
    expect(await bindingResponse.json()).toMatchObject({ botId: replacement.bot.botId, runtimeId: null });
});

function projectRequest(projectId: string, path: string, token: string, method = "GET"): Request {
    return new Request(`${APP_ORIGIN}/morty/api/projects/${projectId}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
    });
}

async function share(projectId: string, token: string): Promise<string> {
    const response = await worker.fetch(
        projectRequest(projectId, "/identity/transfers", token, "POST"),
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
    const redeemed = await redeem(await share(original.projectId, original.token));
    expect(redeemed.status).toBe(200);
    const browser = v.parse(v.object({ token: v.string() }), await redeemed.json()).token;
    const recoveryResponse = await worker.fetch(
        projectRequest(original.projectId, "/identity/recovery-token", browser, "POST"),
        fixture.environment(),
    );
    expect(recoveryResponse.status).toBe(201);
    const recovery = v.parse(v.object({ token: v.string() }), await recoveryResponse.json()).token;
    const unredeemed = await share(original.projectId, original.token);

    const replace = async () =>
        await worker.fetch(
            projectRequest(original.projectId, "/management/project/replacement", original.token, "POST"),
            fixture.environment(),
        );
    const response = await replace();
    expect(response.status).toBe(201);
    const replacement = v.parse(replacementSchema, await response.json());

    for (const token of [browser, recovery]) {
        expect(
            (await worker.fetch(projectRequest(original.projectId, "/session", token), fixture.environment())).status,
        ).toBe(401);
    }
    expect((await redeem(unredeemed)).status).toBe(410);
    // A reply the local identity never received can be asked for again.
    const retry = await replace();
    expect(retry.status).toBe(201);
    expect(v.parse(replacementSchema, await retry.json()).projectId).toBe(replacement.projectId);
});

test("Given a browser that opened a shared link, When it asks to replace the Project, Then only the machine's own identity may", async () => {
    const original = await fixture.createAnonymousUser();
    const redeemed = await redeem(await share(original.projectId, original.token));
    const browser = v.parse(v.object({ token: v.string() }), await redeemed.json()).token;

    const response = await worker.fetch(
        projectRequest(original.projectId, "/management/project/replacement", browser, "POST"),
        fixture.environment(),
    );

    expect(response.status).toBe(403);
    expect(
        (await worker.fetch(projectRequest(original.projectId, "/session", original.token), fixture.environment()))
            .status,
    ).toBe(200);
});

test("Given an unauthenticated request, When a Project replacement is requested, Then it is rejected", async () => {
    const identity = await fixture.createAnonymousUser();
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/morty/api/projects/${identity.projectId}/management/project/replacement`, {
            method: "POST",
        }),
        fixture.environment(),
    );
    expect(response.status).toBe(401);
});
