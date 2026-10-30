import { afterAll, beforeAll, expect, test } from "vitest";
import worker from "../src/application.ts";
import { APP_ORIGIN, anonymousCreationKey, createIdentityFixture } from "./support/identity-fixture.ts";

// A stateful external admission service: tests control quota explicitly rather than waiting for a clock window.
class CreationBudget {
    readonly #remaining = new Map<string, number>();
    readonly limit = async ({ key }: { readonly key: string }) => {
        const remaining = this.#remaining.get(key) ?? 1;
        this.#remaining.set(key, Math.max(0, remaining - 1));
        return { success: remaining > 0 };
    };
}

let fixture: Awaited<ReturnType<typeof createIdentityFixture>>;
beforeAll(async () => {
    fixture = await createIdentityFixture();
});
afterAll(async () => {
    await fixture.close();
});

function creation(headers: Readonly<Record<string, string>> = {}): Request {
    return new Request(`${APP_ORIGIN}/morty/api/identity/anonymous-users`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ creationKey: anonymousCreationKey() }),
    });
}

test("Given an anonymous visitor's creation allowance, When it is exhausted, Then another identity is refused with retry guidance while a different visitor can continue", async () => {
    const environment = { ...fixture.environment(), ANONYMOUS_CREATION_LIMITER: new CreationBudget() };
    const first = await worker.fetch(creation({ "CF-Connecting-IP": "192.0.2.1" }), environment);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ projectId: expect.any(String), token: expect.any(String) });
    const denied = await worker.fetch(
        creation({ "CF-Connecting-IP": "192.0.2.1", "X-Forwarded-For": "192.0.2.2" }),
        environment,
    );
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("60");
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(await denied.json()).toMatchObject({ error: { code: "IDENTITY_CREATION_RATE_LIMITED" } });
    const other = await worker.fetch(creation({ "CF-Connecting-IP": "192.0.2.2" }), environment);
    expect(other.status).toBe(201);
    expect(await other.json()).toMatchObject({ projectId: expect.any(String), token: expect.any(String) });
});

test("Given no trusted client address, When anonymous creation repeats, Then missing metadata shares a bounded allowance", async () => {
    const environment = { ...fixture.environment(), ANONYMOUS_CREATION_LIMITER: new CreationBudget() };
    const first = await worker.fetch(creation(), environment);
    expect(first.status).toBe(201);
    await first.json();
    const denied = await worker.fetch(creation({ "X-Forwarded-For": "192.0.2.3" }), environment);
    expect(denied.status).toBe(429);
});

test("Given unavailable abuse protection, When a visitor asks for a new identity, Then provisioning fails closed without leaking internals", async () => {
    const response = await worker.fetch(creation(), {
        ...fixture.environment(),
        ANONYMOUS_CREATION_LIMITER: undefined,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
        error: {
            code: "IDENTITY_CREATION_UNAVAILABLE",
            message: "New connections are temporarily unavailable. Try again shortly.",
        },
    });
});

test("Given a rejected Platform credential, When a user tries to pair their Machine, Then the HTTP error keeps its code without echoing the upstream message", async () => {
    const identity = await fixture.createAnonymousUser();
    const original = fixture.baseConfiguration.MOBIUS_APP_SECRET;
    try {
        await fixture.changePlatformCredential(`${original.slice(0, -1)}${original.endsWith("A") ? "B" : "A"}`);
        const response = await worker.fetch(
            new Request(`${APP_ORIGIN}/morty/api/projects/${identity.projectId}/management/runtime-pairings`, {
                method: "POST",
                headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json" },
                body: JSON.stringify({ idempotencyKey: "security-error-sanitization" }),
            }),
            fixture.environment(),
        );
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
            error: { message: "Platform could not complete Runtime setup." },
        });
    } finally {
        await fixture.changePlatformCredential(original);
    }
});
