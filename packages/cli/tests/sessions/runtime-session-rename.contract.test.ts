import { expect, it } from "vitest";
import { startTestPlatform } from "../support/platform.ts";

it("Given a prompted local conversation, When the Session is renamed, Then the directory and the controlled Agent show the new title", async () => {
    const cancellation = new AbortController();
    await using platform = await startTestPlatform();
    try {
        const project = await platform.service.createProject(
            {
                clientReference: `client-${crypto.randomUUID()}`,
                displayName: "Runtime Session rename",
                idempotencyKey: `project-${crypto.randomUUID()}`,
                locationHint: "wnam",
            },
            cancellation.signal,
        );
        const runtime = await platform.connectAgent(project.computerId);
        const sessionId = `session-${crypto.randomUUID()}`;
        await runtime.client.sessions.create(
            {
                agentId: "claude",
                configurations: [],
                directoryId: "default",
                computerId: runtime.computerId,
                sessionId,
            },
            cancellation.signal,
        );
        await runtime.client.turns.submitToRuntime(
            sessionId,
            {
                agentId: "claude",
                content: "Remember this conversation",
                directoryId: "default",
                idempotencyKey: `turn-${crypto.randomUUID()}`,
                attachments: [],
            },
            cancellation.signal,
        );

        await expect(
            runtime.client.sessions.rename(
                runtime.computerId,
                sessionId,
                "Renamed by the developer",
                cancellation.signal,
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                kind: "session.renamed",
                sessionId,
                title: "Renamed by the developer",
            }),
        );

        await expect(runtime.client.runtimes.listSessions(100, cancellation.signal)).resolves.toEqual([
            expect.objectContaining({
                agentId: "claude",
                prompted: true,
                sessionId,
                status: { kind: "idle" },
                title: "Renamed by the developer",
            }),
        ]);

        // The controlled Agent harness received the rename: its own native
        // Session listing reports the new title instead of the first prompt.
        const discovery = await runtime.client.runtimes.nativeSessions(
            {
                action: "list",
                agentId: "claude",
                cursor: null,
                directoryId: "default",
                discoveryId: null,
            },
            cancellation.signal,
        );
        expect(discovery).toEqual(
            expect.objectContaining({
                action: "list",
                entries: expect.arrayContaining([expect.objectContaining({ title: "Renamed by the developer" })]),
            }),
        );
    } finally {
        cancellation.abort(new Error("Runtime Session rename test completed"));
    }
});
