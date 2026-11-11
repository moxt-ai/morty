import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
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

it("Given an owned computer, When its internal HTTP boundary reads authority and records an audit, Then it returns current authority and persists the event without exposing the operations publicly", async () => {
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

    const audit = {
        action: "computer.internal-http.verified",
        actorId: owner.userId,
        actorKind: "application",
        actorRef: owner.userId,
        auditId: "internal-http-audit",
        computerId: owner.computerId,
        detailsJson: "{}",
        outcome: "succeeded",
        recordedAt: Date.now(),
        subjectId: owner.computerId,
    };
    expect((await stub.fetch(request(owner.computerId, "audit-events", audit))).status).toBe(204);
    const events = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
            .exec("SELECT audit_id, computer_id, action FROM audit_events WHERE audit_id = ?", audit.auditId)
            .toArray(),
    );
    expect(events).toEqual([{ audit_id: audit.auditId, computer_id: owner.computerId, action: audit.action }]);

    for (const internal of [
        request(owner.computerId, "active-generation"),
        request(owner.computerId, "access-check", { kind: "credential", credentialId: "unknown-credential" }),
        request(owner.computerId, "audit-events", audit),
        request(owner.computerId, "registrations"),
        request(owner.computerId, "revocations", {
            computerId: owner.computerId,
            now: Date.now(),
            actorKind: "application",
            actorId: owner.userId,
            auditId: "public-revocation-denied",
        }),
    ]) {
        const exposed = await ownerRequest(new Request(new URL(new URL(internal.url).pathname, ownerOrigin), internal));
        expect(exposed.status).toBe(404);
    }
    expect((await ownerRequest(request(owner.computerId, "active-generation"))).status).toBe(404);
});

it("Given two owned computers, When an internal request names the wrong object or supplies malformed authority, Then the object rejects it before changing its audit data", async () => {
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
    const audit = await stub.fetch(request(owner.computerId, "audit-events", { computerId: other.computerId }));
    expect(audit.status).toBe(400);
    const foreignAudit = {
        action: "computer.internal-http.denied",
        actorId: owner.userId,
        actorKind: "application",
        actorRef: owner.userId,
        auditId: "foreign-internal-http-audit",
        computerId: other.computerId,
        detailsJson: "{}",
        outcome: "succeeded",
        recordedAt: Date.now(),
        subjectId: other.computerId,
    };
    const unauthorized = await stub.fetch(request(owner.computerId, "audit-events", foreignAudit));
    expect(unauthorized.status).toBe(421);
    const events = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("SELECT audit_id FROM audit_events WHERE audit_id = ?", foreignAudit.auditId).toArray(),
    );
    expect(events).toEqual([]);
});
