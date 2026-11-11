import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable";
import { expect, test } from "vitest";
import { CodexAcpAgent } from "../../src/engine/acp/harness/codex/agent.ts";
import { ControlledCodexFixture } from "../support/agents/controlled-codex.ts";

for (const terminal of ["interrupted", "completed", "failed"] as const) {
    test(`Given Codex defers accepted steering, When its turn is ${terminal} and the endpoint is reused, Then new steering retains its own content despite late old-turn input`, async () => {
        await using fixture = await ControlledCodexFixture.create({
            holdTurn: true,
            skipSecondSteering: true,
            consumeSteeringAfterFirstTurn: true,
            latePreviousUser: true,
            endFirstTurnOnSteering: terminal,
        });
        let started = Promise.withResolvers<void>();
        const updates: SessionUpdate[] = [];
        const consumed = Promise.withResolvers<void>();
        let userChunks = 0;
        const rejectInteraction = async (): Promise<never> => {
            throw new Error("Unexpected interaction");
        };
        const endpoint = new CodexAcpAgent({
            command: fixture.environment["MORTY_CODEX_PATH"] ?? "",
            cwd: process.cwd(),
            environment: fixture.environment,
            interactions: { onPermission: rejectInteraction, onElicitation: rejectInteraction },
            onSessionUpdate: async ({ update }) => {
                updates.push(update);
                if (
                    update.sessionUpdate === "user_message_chunk" &&
                    update.messageId === "controlled-steering-user-2"
                ) {
                    consumed.resolve();
                }
                if (update.sessionUpdate === "user_message_chunk") {
                    userChunks += 1;
                    if (update.messageId === "controlled-user-2") {
                        started.resolve();
                    }
                }
                if (userChunks > 0 && update.sessionUpdate === "config_option_update") {
                    started.resolve();
                }
            },
        });
        const signal = AbortSignal.timeout(30_000);
        try {
            await endpoint.initialize(signal);
            const session = await endpoint.newSession({ cwd: process.cwd() }, signal);
            const running = endpoint.prompt({
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "Hold the turn" }],
            });
            void running.catch(() => {});
            await started.promise;
            const response = await endpoint.steer(
                { sessionId: session.sessionId, prompt: [{ type: "text", text: "Use the new requirement" }] },
                signal,
            );
            expect(response).toMatchObject({ outcome: "injected" });
            expect(userChunks).toBe(1);
            await running.catch(() => undefined);
            started = Promise.withResolvers<void>();
            const reused = endpoint.prompt({
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "New turn" }],
            });
            void reused.catch(() => {});
            await started.promise;
            expect(
                await endpoint.steer(
                    {
                        sessionId: session.sessionId,
                        prompt: [{ type: "text", text: "Rejected by the native submission hook" }],
                    },
                    signal,
                ),
            ).toMatchObject({ outcome: "injected" });
            expect(
                await endpoint.steer(
                    {
                        sessionId: session.sessionId,
                        prompt: [
                            {
                                type: "resource",
                                resource: {
                                    uri: "morty://new-steering",
                                    text: "New requirement",
                                    mimeType: "text/plain",
                                },
                            },
                        ],
                    },
                    signal,
                ),
            ).toMatchObject({ outcome: "injected" });
            await consumed.promise;
            expect(
                updates.filter(
                    (update) =>
                        update.sessionUpdate === "user_message_chunk" &&
                        update.messageId === "controlled-steering-user-2",
                ),
            ).toMatchObject([
                { content: { type: "resource", resource: { uri: "morty://new-steering", text: "New requirement" } } },
            ]);
            expect(
                updates.filter(
                    (update) =>
                        update.sessionUpdate === "user_message_chunk" && update.messageId === "controlled-user-2",
                ),
            ).toMatchObject([{ content: { type: "text", text: "New turn" } }]);
            await endpoint.cancel({ sessionId: session.sessionId });
            await reused.catch(() => undefined);
        } finally {
            await endpoint.dispose("force");
        }
    });
}
