import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import worker from "../src/application.ts";
import { APP_ORIGIN } from "./support/clerk.ts";
import { createIdentityFixture } from "./support/identity-fixture.ts";

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
