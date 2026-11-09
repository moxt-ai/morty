import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSessionReadyEvent } from "@morty-build/client/protocol";
import { MortyClient, StaticMortyCredentialProvider } from "@morty-build/client/server";
import { expect, it } from "vitest";
import { startTestPlatform } from "../support/platform.ts";

for (const client of ["SDK", "HTTP"] as const) {
    it(`Given a new Session, When ${client} creates and prompts it, Then its conversation uses the Runtime title and workspace`, async () => {
        const cancellation = new AbortController();
        await using platform = await startTestPlatform();
        try {
            const project = await platform.service.createProject(
                {
                    clientReference: `client-${crypto.randomUUID()}`,
                    displayName: "Runtime Session directory",
                    idempotencyKey: `project-${crypto.randomUUID()}`,
                    locationHint: "wnam",
                },
                cancellation.signal,
            );
            const runtime = await platform.connectAgent(project.computerId);
            const request = {
                agentId: "claude",
                configurations: [],
                directoryId: "default",
                computerId: runtime.computerId,
                operationId: crypto.randomUUID(),
            };
            const ready =
                client === "SDK"
                    ? await runtime.client.sessions.create(request, cancellation.signal)
                    : await (async () => {
                          const response = await platform.app.request(
                              new Request(
                                  `${platform.baseUrl}/morty/api/v1/computers/${project.computerId}/daemon/sessions`,
                                  {
                                      method: "POST",
                                      headers: {
                                          authorization: `Bearer ${platform.appCredential}`,
                                          "content-type": "application/json",
                                      },
                                      body: JSON.stringify(request),
                                      signal: cancellation.signal,
                                  },
                              ),
                          );
                          expect(response.status).toBe(200);
                          return decodeSessionReadyEvent(await response.text());
                      })();
            const { target: sessionTarget } = ready;
            expect(ready).toMatchObject({
                kind: "session.ready",
                target: sessionTarget,
                agentId: "claude",
                directoryId: "default",
            });
            await runtime.client.turns.submitToRuntime(
                sessionTarget,
                {
                    agentId: "claude",
                    attachments: [],
                    content: "Remember this conversation",
                    directoryId: "default",
                    idempotencyKey: `turn-${crypto.randomUUID()}`,
                },
                cancellation.signal,
            );

            await expect(runtime.client.runtimes.listSessions(100, cancellation.signal)).resolves.toEqual([
                expect.objectContaining({
                    agentId: "claude",
                    directoryId: expect.any(String),
                    prompted: true,
                    target: sessionTarget,
                    // Admission does not wait for completion; either live state describes this conversation.
                    status: expect.objectContaining({ kind: expect.stringMatching(/^(idle|working)$/u) }),
                    title: "Remember this conversation",
                }),
            ]);
        } finally {
            cancellation.abort(new Error("Runtime Session directory test completed"));
        }
    });
}

it("Given long ASCII and multibyte directory references, When the SDK browses them, Then the local filesystem remains the authority for directory availability", async () => {
    await using platform = await startTestPlatform();
    const signal = AbortSignal.timeout(30_000);
    const project = await platform.service.createProject(
        {
            clientReference: `client-${crypto.randomUUID()}`,
            displayName: "Long directory references",
            idempotencyKey: `project-${crypto.randomUUID()}`,
            locationHint: "wnam",
        },
        signal,
    );
    const runtime = await platform.connectAgent(project.computerId);
    for (const segment of ["a".repeat(220), "\u00e9".repeat(110)]) {
        const path = join(tmpdir(), `missing-${crypto.randomUUID()}`, ...Array.from({ length: 8 }, () => segment));
        const directoryId = `path-${Buffer.from(path).toString("base64url")}`;
        expect(directoryId.length).toBeGreaterThan(2048);
        await expect(runtime.client.runtimes.listWorkspace(directoryId, signal)).rejects.toMatchObject({
            code: "local_authorization_failed",
            message: "This directory is missing or unavailable to your user account",
        });
    }
});

it("Given a deeply nested multibyte project path, When the SDK browses it and runs a conversation, Then directory metadata and native history remain accessible", async () => {
    const root = await mkdtemp(join(tmpdir(), "morty-long-workspace-"));
    try {
        const path = join(
            root,
            ...Array.from({ length: process.platform === "linux" ? 8 : 3 }, () => "\u00e9".repeat(110)),
        );
        await mkdir(path, { recursive: true });
        const canonical = await realpath(path);
        await using platform = await startTestPlatform();
        const signal = AbortSignal.timeout(30_000);
        const project = await platform.service.createProject(
            {
                clientReference: `client-${crypto.randomUUID()}`,
                displayName: "Long project",
                idempotencyKey: `project-${crypto.randomUUID()}`,
                locationHint: "wnam",
            },
            signal,
        );
        const runtime = await platform.connectAgent(project.computerId);
        const directoryId = `path-${Buffer.from(canonical).toString("base64url")}`;
        const listing = await runtime.client.runtimes.listWorkspace(directoryId, signal);
        expect(listing.directoryId).toBe(directoryId);
        expect(listing.directoryLabel).toBe(canonical);
        if (process.platform === "linux") {
            expect(listing.parentDirectoryId.length).toBeGreaterThan(2048);
        }
        const identity = { agentId: "claude", directoryId };
        const { target: sessionTarget } = await runtime.client.sessions.create(
            {
                ...identity,
                configurations: [],
                computerId: runtime.computerId,
                operationId: crypto.randomUUID(),
            },
            signal,
        );
        await runtime.client.turns.submitToRuntime(
            sessionTarget,
            {
                ...identity,
                content: "Remember the long workspace conversation",
                idempotencyKey: `turn-${crypto.randomUUID()}`,
                attachments: [],
            },
            signal,
        );
        expect(await runtime.client.runtimes.listSessions(100, signal)).toContainEqual(
            expect.objectContaining({ target: sessionTarget, directoryId, directoryLabel: canonical, prompted: true }),
        );
        const discovery = await runtime.client.runtimes.nativeSessions(
            { ...identity, action: "list", cursor: null, discoveryId: null },
            signal,
        );
        if (discovery.action !== "list" || discovery.entries[0] === undefined) {
            throw new Error("Missing native conversation in the long workspace");
        }
        expect(discovery.entries[0]).toMatchObject({
            sessionId: sessionTarget.sessionId,
            directoryId,
            directoryLabel: canonical,
        });
        const events = await runtime.client.sessions.previewRuntimeNativeEvents(
            sessionTarget,
            identity,
            { cursor: null, eventLimit: 100 },
            signal,
        );
        expect(JSON.stringify(events)).toContain("Remember the long workspace conversation");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

it("Given a Session in a selected workspace, When the App prompts it and reads its execution without stating its binding, Then the Runtime runs the Turn in the Session's own workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "morty-session-workspace-"));
    try {
        const directoryLabel = await realpath(workspace);
        const directoryId = `path-${Buffer.from(directoryLabel).toString("base64url")}`;
        await using platform = await startTestPlatform();
        const signal = AbortSignal.timeout(30_000);
        const project = await platform.service.createProject(
            {
                clientReference: `client-${crypto.randomUUID()}`,
                displayName: "Session binding",
                idempotencyKey: `project-${crypto.randomUUID()}`,
                locationHint: "wnam",
            },
            signal,
        );
        const runtime = await platform.connectAgent(project.computerId);
        const { target: sessionTarget } = await runtime.client.sessions.create(
            {
                agentId: "claude",
                configurations: [],
                directoryId,
                computerId: runtime.computerId,
                operationId: crypto.randomUUID(),
            },
            signal,
        );
        const access = await runtime.client.sessions.createAccess(sessionTarget, 900, signal);
        const session = new MortyClient({
            endpoint: platform.baseUrl,
            computerId: project.computerId,
            credentialProvider: new StaticMortyCredentialProvider(access.credential),
            transport: { fetch: async (request: Request) => await platform.app.request(request) },
        });

        const turn = await session.turns.submit(
            sessionTarget,
            {
                attachments: [],
                content: "Remember the selected workspace",
                idempotencyKey: `turn-${crypto.randomUUID()}`,
            },
            signal,
        );
        await expect(
            session.sessions.readSessionExecution(sessionTarget, {}, signal, turn.turnId),
        ).resolves.toHaveProperty("command");

        expect(await runtime.client.runtimes.listSessions(100, signal)).toContainEqual(
            expect.objectContaining({
                agentId: "claude",
                directoryId,
                directoryLabel,
                prompted: true,
                target: sessionTarget,
                title: "Remember the selected workspace",
            }),
        );
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});
