import { expect, test } from "vitest";
import { createIdentityFixture } from "./support/identity-fixture.ts";

test("Given a creation operation still applying initial settings, When another caller changes its inputs, Then the conflict is refused and a corrected retry after initialization fails creates a retained native Session", {
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
        const operationId = crypto.randomUUID();
        const input = {
            additionalDirectoryIds: [],
            agentId: "configuration-test",
            directoryId: "default",
            computerId: runtime.computerId,
            operationId,
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
                code: "idempotency_conflict",
            });
        } finally {
            release.resolve();
        }
        expect(await refused).toMatchObject({ ok: false, cause: { code: "session_configuration_conflict" } });
        await expect(runtime.client.sessions.readCreation(operationId, signal)).rejects.toMatchObject({
            code: "session_creation_unavailable",
        });
        const successful = await runtime.client.sessions.create({ ...input, configurations: [] }, signal);
        expect(successful.target.sessionId).not.toBe(operationId);
        expect(await runtime.client.runtimes.querySessions([successful.target], signal)).toHaveLength(1);
    } finally {
        release.resolve();
        await cloud.close();
    }
});
