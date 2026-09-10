import { expect, it } from "vitest";
import { MobiusGateway } from "../../../packages/worker/src/components/slack/gateway/mobius-gateway";
import { createTestApplication } from "./test-app";

// The host gateway records user-owned pairing without live Mobius credentials.
class UserBotPairingGateway extends MobiusGateway {
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

it("Given a signed-in user, When pairing input supplies another identity, Then the host creates the pairing for the authenticated user", async () => {
    const app = await createTestApplication(false, (cx) => new UserBotPairingGateway(cx));
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

it("Given no authenticated user, When a client requests pairing, Then access is denied without creating a pairing", async () => {
    const hosts: UserBotPairingGateway[] = [];
    const app = await createTestApplication(false, (cx) => {
        const host = new UserBotPairingGateway(cx);
        hosts.push(host);
        return host;
    });
    const unauthenticated = await app.request("/mobius-slack/api/slack/mobius/pairings", { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    const noUser = await app.request("/mobius-slack/api/slack/mobius/pairings", {
        method: "POST",
        headers: { authorization: `Bearer ${await app.humanToken(null)}` },
    });
    expect(noUser.status).toBe(403);
    expect(hosts.flatMap((host) => [...host.pairings])).toEqual([]);
});
