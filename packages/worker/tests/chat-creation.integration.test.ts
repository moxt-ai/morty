import { MobiusAppCredentialProvider } from "@moxt-ai/mobius-sdk/platform";
import { MobiusClient, MobiusPageRequest } from "@moxt-ai/mobius-sdk/server";
import { Hono } from "hono";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import * as v from "valibot";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../src/application.ts";
import { InMemoryD1Database } from "./infra/database.ts";
import { AUTH_TIME } from "./support/clerk.ts";
import { platformPeer } from "./support/platform-peer.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AUTH_TIME);
});
afterEach(() => vi.useRealTimers());

test.each([true, false])(
    "Given a paired workspace with settings available=%s, When Chat configures a draft and sends a supported Turn, Then available settings deliver it and unavailable settings retain Platform's error details",
    async (settingsAvailable) => {
        const platform = await platformPeer({ agentsOnline: true, settingsAvailable });
        const database = new InMemoryD1Database();
        const storage = new Miniflare(
            convertV4MiniflareOptions({
                modules: true,
                script: "export default { fetch() { return new Response(); } }",
                r2Buckets: ["ATTACHMENTS"],
                compatibilityDate: "2026-09-03",
            }),
        );
        try {
            const attachments = await storage.getR2Bucket("ATTACHMENTS");
            const base = {
                ...platform.bindings,
                APP_ORIGIN: "https://cloud.test",
                CHAT_ATTACHMENTS_APAC: attachments,
                CHAT_ATTACHMENTS_WNAM: attachments,
            };
            const projects = {
                idFromName: (name: string) => name,
                get: (projectId: string) => ({
                    fetch: (request: Request) =>
                        worker.fetch(request, {
                            ...base,
                            ATTACHMENTS: attachments,
                            CHAT_PROJECT_ID: projectId,
                            DATABASE: database,
                        }),
                }),
            };
            const app = new Hono().all("*", (context) =>
                worker.fetch(context.req.raw, { ...base, CHAT_PROJECTS: projects }),
            );
            const identity = v.parse(
                v.object({ token: v.string(), projectId: v.string() }),
                await (
                    await app.request("https://cloud.test/mobius-cloud/api/identity/anonymous-users", {
                        method: "POST",
                    })
                ).json(),
            );
            const request = (path: string, body?: object) =>
                app.request(
                    `https://cloud.test/mobius-cloud/api/${path.startsWith("chat/") ? path.replace("chat/", `chat/projects/${identity.projectId}/`) : `projects/${identity.projectId}/${path}`}`,
                    {
                        method: body === undefined ? "GET" : "POST",
                        headers: {
                            authorization: `Bearer ${identity.token}`,
                            "content-type": "application/json",
                        },
                        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    },
                );
            const { bots } = v.parse(
                v.object({ bots: v.array(v.object({ botId: v.string() })) }),
                await (await request("management/bots")).json(),
            );
            const bot = bots[0];
            if (bot === undefined) {
                throw new Error("Expected a Bot");
            }
            const profile = await app.request(
                `https://cloud.test/mobius-cloud/api/projects/${identity.projectId}/management/bots/${bot.botId}`,
                {
                    method: "PATCH",
                    headers: {
                        authorization: `Bearer ${identity.token}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({
                        displayName: "Test Bot",
                        instructions: "Answer as the configured Chat Bot.",
                    }),
                },
            );
            expect(profile.status).toBe(200);
            expect((await request(`chat/bots/${bot.botId}/workspace`, {})).status).toBe(200);
            const configured = await request(`chat/bots/${bot.botId}/setup`, {
                runtimeId: "runtime-1",
                agentRef: "agent-one",
                workspaceRef: "default",
                agentConfigRevision: 1,
            });
            expect(configured.status).toBe(settingsAvailable ? 202 : 409);
            if (!settingsAvailable) {
                expect(await configured.json()).toEqual({
                    error: {
                        code: "agent_unavailable",
                        message: "Platform could not complete Runtime setup. Cause: The settings agent is unavailable",
                    },
                });
            }
            expect(await (await request(`chat/bots/${bot.botId}/managed-sessions`, {})).json()).toEqual({
                sessions: [],
            });
            const prepared = await request(`chat/bots/${bot.botId}/agent-settings`, {});
            expect(prepared.status).toBe(settingsAvailable ? 200 : 409);
            if (settingsAvailable) {
                expect(await prepared.json()).toMatchObject({
                    bindingId: expect.stringMatching(/^binding[-_]/u),
                    settings: {
                        settings: expect.arrayContaining([
                            expect.objectContaining({ id: "model", defaultValue: "model-one" }),
                        ]),
                    },
                });
                expect(
                    await (
                        await request(`chat/bots/${bot.botId}/workspace/directory`, { directoryId: "default" })
                    ).json(),
                ).toMatchObject({
                    directoryLabel: "/home/a/mobius.t3",
                    entries: [
                        {
                            directoryId: "path-L2hvbWUvYS9tb2JpdXMudDMvc2VsZWN0ZWQtcHJvamVjdA",
                            name: "selected-project",
                        },
                    ],
                });
                expect(
                    await (
                        await request(`chat/bots/${bot.botId}/workspace/directory`, {
                            directoryId: "path-L2hvbWUvYS9tb2JpdXMudDMvc2VsZWN0ZWQtcHJvamVjdA",
                        })
                    ).json(),
                ).toMatchObject({
                    directoryId: "path-L2hvbWUvYS9tb2JpdXMudDMvc2VsZWN0ZWQtcHJvamVjdA",
                    directoryLabel: "/home/a/mobius.t3/selected-project",
                });
            }
            const projectClient = new MobiusClient({
                endpoint: platform.bindings.MOBIUS_BASE_URL,
                projectId: identity.projectId,
                credentialProvider: new MobiusAppCredentialProvider(platform.bindings.MOBIUS_APP_SECRET),
            });
            try {
                expect(
                    (await projectClient.sessions.list(new MobiusPageRequest(100, ""), AbortSignal.timeout(5000)))
                        .sessions,
                ).toEqual([]);
            } finally {
                projectClient.close();
            }
            const input = {
                conversationKey: "first-draft",
                workspaceRef: "path-L2hvbWUvYS9tb2JpdXMudDMvc2VsZWN0ZWQtcHJvamVjdA",
                bindingId: settingsAvailable
                    ? v.parse(
                          v.object({ bindingId: v.string() }),
                          await (await request(`chat/bots/${bot.botId}/agent-settings`, {})).json(),
                      ).bindingId
                    : "unconfigured",
                permissionMode: "read-only",
                configuration: {
                    additionalDirectoryIds: [],
                    booleanValue: false,
                    configId: "model",
                    value: "model-one",
                    valueType: "select",
                },
            };
            const firstResponse = await request(`chat/bots/${bot.botId}/access`, input);
            if (!settingsAvailable) {
                // An agent that cannot prepare a Session must fail chat creation the same way it fails draft settings.
                expect(firstResponse.status).toBe(409);
                return;
            }
            expect(firstResponse.status).toBe(200);
            expect(platform.configuredSettings()).toEqual([
                {
                    booleanValue: false,
                    configId: "permission_mode",
                    value: "read-only",
                    valueType: "select",
                },
                {
                    booleanValue: false,
                    configId: "model",
                    value: "model-one",
                    valueType: "select",
                },
            ]);
            const schema = v.object({ conversationId: v.string() });
            const first = v.parse(schema, await firstResponse.json());
            expect(
                (await projectClient.sessions.read(first.conversationId, AbortSignal.timeout(5000))).defaultBinding
                    .workspaceRef,
            ).toBe(input.workspaceRef);
            const image = { data: "A".repeat(3_000_000), mimeType: "image/png", name: "large-screenshot.png" };
            const turn = await request(`chat/bots/${bot.botId}/turns`, {
                sessionId: first.conversationId,
                additionalDirectoryIds: [],
                artifactIds: [],
                content: "Hello",
                idempotencyKey: "command-1",
                images: [image],
                resources: [],
            });
            expect(turn.status).toBe(200);
            expect(platform.submittedTurns()).toMatchObject([
                {
                    images: [image],
                    resources: [
                        {
                            type: "embedded",
                            uri: "mobius-chat://bot/instructions",
                            name: "Bot instructions",
                            text: "Answer as the configured Chat Bot.",
                        },
                    ],
                },
            ]);
            expect(
                (await request(`chat/bots/${bot.botId}/access`, { ...input, bindingId: "different-binding" })).status,
            ).toBe(409);
            const second = v.parse(
                schema,
                await (
                    await request(`chat/bots/${bot.botId}/access`, { ...input, conversationKey: "second-draft" })
                ).json(),
            );
            expect(second.conversationId).not.toBe(first.conversationId);
            expect(await (await request(`chat/bots/${bot.botId}/access`, input)).json()).toMatchObject(first);
            expect(
                await (await request(`chat/bots/${bot.botId}/access`, { conversationId: first.conversationId })).json(),
            ).toMatchObject(first);
            const listed = await request(`chat/bots/${bot.botId}/managed-sessions`, {});
            expect(listed.status).toBe(200);
            expect(await listed.json()).toMatchObject({
                sessions: expect.arrayContaining([
                    {
                        kind: "conversation",
                        id: first.conversationId,
                        title: "New chat",
                        userId: expect.any(String),
                        projectId: identity.projectId,
                    },
                    {
                        kind: "conversation",
                        id: second.conversationId,
                        title: "New chat",
                        userId: expect.any(String),
                        projectId: identity.projectId,
                    },
                ]),
            });
            const other = v.parse(
                v.object({ token: v.string(), projectId: v.string() }),
                await (
                    await app.request("https://cloud.test/mobius-cloud/api/identity/anonymous-users", {
                        method: "POST",
                    })
                ).json(),
            );
            for (const scope of [
                { token: other.token, projectId: identity.projectId },
                { token: identity.token, projectId: other.projectId },
            ]) {
                const forbidden = await app.request(
                    `https://cloud.test/mobius-cloud/api/chat/projects/${scope.projectId}/bots/${bot.botId}/managed-sessions`,
                    {
                        method: "POST",
                        headers: { authorization: `Bearer ${scope.token}`, "content-type": "application/json" },
                        body: "{}",
                    },
                );
                expect(forbidden.status).toBe(401);
            }
            expect(
                (await request(`chat/bots/${bot.botId}/managed-session`, { sessionId: "unknown-fork" })).status,
            ).toBe(404);
        } finally {
            await platform.close();
            database.close();
            await storage.dispose();
        }
    },
);
