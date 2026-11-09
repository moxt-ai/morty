import { expect, test } from "vitest";
import { createIdentityFixture } from "./support/identity-fixture.ts";

test("Given a Session still applying initial settings, When another caller creates it, Then it is busy until initialization settles and a retry creates a retained Session", {
    timeout: 60000,
}, async () => {
    const cloud = await createIdentityFixture();
    const applying = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
        const identity = await cloud.createAnonymousUser();
        await using runtime = await cloud.connectAgent(identity.computerId, [
            {
                id: "configuration-test",
                label: "Settings Agent",
                beforeConfigurationApplied: async (configId, value) => {
                    if (configId === "model" && value === "test-large") {
                        applying.resolve();
                        await release.promise;
                    }
                },
            },
        ]);
        const signal = AbortSignal.timeout(30000);
        const sessionId = crypto.randomUUID();
        const input = {
            additionalDirectoryIds: [],
            agentId: "configuration-test",
            directoryId: "default",
            pairingId: runtime.pairingId,
            sessionId,
        };
        const refused = runtime.client.sessions
            .create(
                {
                    ...input,
                    configurations: [
                        { configId: "model", valueType: "select", value: "test-large", booleanValue: false },
                        { configId: "missing-option", valueType: "select", value: "anything", booleanValue: false },
                    ],
                },
                signal,
            )
            .then(
                (value) => ({ ok: true, value }),
                (cause) => ({ ok: false, cause }),
            );
        await applying.promise;
        try {
            await expect(
                runtime.client.sessions.create({ ...input, configurations: [] }, signal),
            ).rejects.toMatchObject({
                code: "session_busy",
            });
        } finally {
            release.resolve();
        }
        expect(await refused).toMatchObject({ ok: false, cause: { code: "session_configuration_conflict" } });
        expect(await runtime.client.runtimes.querySessions(runtime.pairingId, [sessionId], signal)).toHaveLength(0);
        const successful = await runtime.client.sessions.create({ ...input, configurations: [] }, signal);
        expect(successful.sessionId).toBe(sessionId);
        expect(await runtime.client.runtimes.querySessions(runtime.pairingId, [sessionId], signal)).toHaveLength(1);
    } finally {
        release.resolve();
        await cloud.close();
    }
});
