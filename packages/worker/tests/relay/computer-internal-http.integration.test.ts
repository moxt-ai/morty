import { abortAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOwner, ownerOrigin, ownerRequest } from "./owner-fixture.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-11T00:00:00Z") }));
afterEach(() => vi.useRealTimers());
afterAll(() => abortAllDurableObjects());

const internalPath = (computerId: string, resource: string) => `/__computer/computers/${computerId}/${resource}`;
const request = (computerId: string, resource: string, body?: unknown) =>
    new Request(`https://computer-relay.internal${internalPath(computerId, resource)}`, {
        method: body === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

it("Given an owned computer, When its internal HTTP boundary reads authority, Then it returns current authority without exposing the operations publicly", async () => {
    const owner = await createOwner();
    const stub = env.COMPUTER_RELAY.getByName(owner.computerId);
    const generation = await stub.fetch(request(owner.computerId, "active-generation"));
    expect(generation.status).toBe(200);
    expect(await generation.json()).toEqual({ generation: null });

    const access = await stub.fetch(
        request(owner.computerId, "access-check", {
            kind: "credential",
            credentialId: "unknown-credential",
        }),
    );
    expect(access.status).toBe(200);
    expect(await access.json()).toEqual({ holdsAccess: false });

    for (const internal of [
        request(owner.computerId, "active-generation"),
        request(owner.computerId, "access-check", { kind: "credential", credentialId: "unknown-credential" }),
    ]) {
        const exposed = await ownerRequest(new Request(new URL(new URL(internal.url).pathname, ownerOrigin), internal));
        expect(exposed.status).toBe(404);
    }
    expect((await ownerRequest(request(owner.computerId, "active-generation"))).status).toBe(404);
});

it("Given two owned computers, When an internal request names the wrong object or supplies malformed authority, Then the object rejects it", async () => {
    const owner = await createOwner();
    const other = await createOwner();
    const stub = env.COMPUTER_RELAY.getByName(owner.computerId);
    const mismatched = await stub.fetch(request(other.computerId, "active-generation"));
    expect(mismatched.status).toBe(421);
    expect(await mismatched.json()).toMatchObject({ error: { code: "computer_id_mismatch" } });
    for (const body of [{ kind: "credential" }, { kind: "device", deviceId: 123 }, { kind: "untrusted" }]) {
        const invalid = await stub.fetch(request(owner.computerId, "access-check", body));
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
});
