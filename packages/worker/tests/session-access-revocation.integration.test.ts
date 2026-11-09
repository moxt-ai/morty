import * as v from "valibot";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../src/application.ts";
import { APP_ORIGIN, AUTH_TIME, createIdentityFixture } from "./support/identity-fixture.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AUTH_TIME);
});
afterEach(() => vi.useRealTimers());

test("Given a browser opening a Session, When its device is revoked before the Runtime finishes creation, Then its pending open cannot grant fresh Session access", async () => {
    const cloud = await createIdentityFixture();
    const creation = Promise.withResolvers<void>();
    const continueCreation = Promise.withResolvers<void>();
    let hold = false;
    try {
        const owner = await cloud.createAnonymousUser();
        await using runtime = await cloud.connectAgent(owner.computerId, [
            {
                id: "configuration-test",
                label: "Configuration Test",
                beforeSessionCreated: async () => {
                    if (hold) {
                        hold = false;
                        creation.resolve();
                        await continueCreation.promise;
                    }
                },
            },
        ]);
        const env = cloud.environment();
        const request = (path: string, token: string, body?: object, method = body === undefined ? "GET" : "POST") =>
            worker.fetch(
                new Request(`${APP_ORIGIN}/morty/api/${path}`, {
                    method,
                    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                }),
                env,
            );
        const project = `computers/${owner.computerId}`;
        const chat = `chat/computers/${owner.computerId}`;
        expect(
            (
                await request(`${chat}/setup`, owner.token, {
                    computerId: runtime.computerId,
                    agentRef: "configuration-test",
                })
            ).status,
        ).toBe(202);
        const shared = await request(`${project}/identity/transfers`, owner.token, {
            operationId: crypto.randomUUID(),
        });
        const code = new URL(v.parse(v.object({ url: v.string() }), await shared.json()).url).hash.slice(6);
        const redeemed = await request("identity/transfers/redeem", owner.token, { code, device: "Revoked browser" });
        expect(redeemed.status).toBe(200);
        const browser = v.parse(v.object({ token: v.string() }), await redeemed.json()).token;
        const { devices } = v.parse(
            v.object({ devices: v.array(v.object({ id: v.string(), label: v.nullable(v.string()) })) }),
            await (await request(`${project}/identity/devices`, owner.token)).json(),
        );
        const device = devices.find((entry) => entry.label === "Revoked browser");
        if (device === undefined) {
            throw new Error("Missing revoked browser");
        }
        hold = true;
        const opening = request(`${chat}/access`, browser, {
            agentRef: "configuration-test",
            configurations: [],
            conversationKey: "revocation-race",
            workspaceRef: "default",
        });
        await creation.promise;
        const revoked = await request(`${project}/identity/v1/devices/${device.id}`, owner.token, undefined, "DELETE");
        expect(revoked.status).toBe(200);
        expect(await revoked.json()).toMatchObject({ sessionAccess: "revoked" });
        expect((await request(`${project}/session`, browser)).status).toBe(401);
        continueCreation.resolve();
        const opened = await opening;
        expect(opened.status).toBe(401);
        expect(await opened.json()).toEqual({
            error: { code: "UNAUTHENTICATED", message: "Access to this computer has ended.", reason: "ACCESS_REVOKED" },
        });
    } finally {
        continueCreation.resolve();
        await cloud.close();
    }
}, 45_000);
