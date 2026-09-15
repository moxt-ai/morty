import { MobiusAppCredentialProvider } from "@moxt-ai/mobius-sdk/platform";
import { MobiusClient, MobiusPageRequest } from "@moxt-ai/mobius-sdk/server";
import { Hono } from "hono";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import * as v from "valibot";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../src/application.ts";
import { InMemoryD1Database } from "./infra/database.ts";
import { AUTH_TIME } from "./support/identity-provider.ts";
import { platformPeer } from "./support/platform-peer.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AUTH_TIME);
});
afterEach(() => vi.useRealTimers());

test.each([true, false])(
    "Given a paired workspace with settings available=%s, When a draft loads models and sends, Then temporary sessions are released and created conversations retain distinct identities",
    async (settingsAvailable) => {
        const platform = await platformPeer({ activeBots: true, settingsAvailable });
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
            const app = new Hono().all("*", (context) =>
                worker.fetch(context.req.raw, {
                    ...platform.bindings,
                    APP_ORIGIN: "https://cloud.test",
                    DATABASE: database,
                    CHAT_DATABASE_APAC: database,
                    CHAT_DATABASE_WNAM: database,
                    CHAT_ATTACHMENTS_APAC: attachments,
                    CHAT_ATTACHMENTS_WNAM: attachments,
                }),
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
                app.request(`https://cloud.test/mobius-cloud/api/${path}`, {
                    method: body === undefined ? "GET" : "POST",
                    headers: {
                        authorization: `Bearer ${identity.token}`,
                        "X-Mobius-Project-Id": identity.projectId,
                        "content-type": "application/json",
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                });
            const { bots } = v.parse(
                v.object({ bots: v.array(v.object({ botId: v.string() })) }),
                await (await request("management/bots")).json(),
            );
            const bot = bots[0];
            if (bot === undefined) {
                throw new Error("Expected a Bot");
            }
            const prepared = await request(`chat/bots/${bot.botId}/draft-settings`, {});
            expect(prepared.status).toBe(settingsAvailable ? 200 : 409);
            if (settingsAvailable) {
                expect(await prepared.json()).toMatchObject({
                    bindingId: "binding-1",
                    ready: { configOptions: [expect.objectContaining({ id: "model", currentValue: "model-one" })] },
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
                bindingId: "binding-1",
                configuration: {
                    additionalDirectoryIds: [],
                    booleanValue: false,
                    configId: "model",
                    value: "model-one",
                    valueType: "select",
                },
            };
            const firstResponse = await request(`chat/bots/${bot.botId}/access`, input);
            expect(firstResponse.status).toBe(200);
            const schema = v.object({ conversationId: v.string() });
            const first = v.parse(schema, await firstResponse.json());
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
        } finally {
            await platform.close();
            database.close();
            await storage.dispose();
        }
    },
);
