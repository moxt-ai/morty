import { expect, it } from "vitest";
import { MobiusGateway } from "../../src/gateway/mobius-gateway";
import { createTestApplication } from "./test-app";

// Cloud owns workspace pairing; this host gateway owns pairing records without live Cloud credentials.
class WorkspacePairingGateway extends MobiusGateway {
    readonly pairings = new Map<string, string>();

    override readonly createPairing = async (_credential: string | null, signal: AbortSignal, tenantId: string) => {
        signal.throwIfAborted();
        const pairingId = crypto.randomUUID();
        this.pairings.set(pairingId, tenantId);
        return {
            channelId: pairingId,
            tenantId,
            pairingId,
            projectId: pairingId,
            pairingCode: "ABCD-1234",
            pollToken: "p".repeat(32),
            hostToken: "h".repeat(32),
            expiresAt: "2030-01-01T00:00:00.000Z",
        };
    };
}

it("Given a signed-in workspace member, When pairing supplies another workspace, Then the host creates the pairing in the authenticated workspace", async () => {
    const app = await createTestApplication(false, (cx) => new WorkspacePairingGateway(cx));
    for (const tenantId of ["tenant-1", "tenant-2"]) {
        const response = await app.request("/mobius-slack/api/slack/mobius/pairings?tenantId=attacker", {
            method: "POST",
            headers: {
                authorization: `Bearer ${await app.humanToken(tenantId)}`,
                "Content-Type": "application/json",
                "X-Tenant-Id": "attacker",
            },
            body: JSON.stringify({ tenantId: "attacker" }),
        });
        expect(response.status).toBe(201);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.json()).toMatchObject({ tenantId, relayUrl: "https://mobius.test" });
    }
});

it("Given no authenticated workspace, When a client requests pairing, Then access is denied without creating a pairing", async () => {
    const hosts: WorkspacePairingGateway[] = [];
    const app = await createTestApplication(false, (cx) => {
        const host = new WorkspacePairingGateway(cx);
        hosts.push(host);
        return host;
    });
    const unauthenticated = await app.request("/mobius-slack/api/slack/mobius/pairings", { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    const noWorkspace = await app.request("/mobius-slack/api/slack/mobius/pairings", {
        method: "POST",
        headers: { authorization: `Bearer ${await app.humanToken(null)}` },
    });
    expect(noWorkspace.status).toBe(403);
    expect(hosts.flatMap((host) => [...host.pairings])).toEqual([]);
});
