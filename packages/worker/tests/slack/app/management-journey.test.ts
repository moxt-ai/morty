import { FakeClerk } from "@moxt-ai/mobius-test/clerk";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { createTestApplication } from "./test-app";

async function authorization(app: Awaited<ReturnType<typeof createTestApplication>>) {
    return { authorization: `Bearer ${await app.humanToken()}` };
}

async function oauthUrl(app: Awaited<ReturnType<typeof createTestApplication>>) {
    const response = await app.request("/mobius-slack/api/slack/oauth/url?slackBotId=bot-1", {
        headers: await authorization(app),
    });
    expect(response.status).toBe(200);
    return new URL(v.parse(v.object({ url: v.string() }), await response.json()).url);
}

describe("Slack management journeys", () => {
    it("Given a workspace owner, When Slack is installed, replaced, and removed, Then every management state is visible", async () => {
        const app = await createTestApplication();
        const headers = await authorization(app);
        const jsonHeaders = { ...headers, "Content-Type": "application/json" };
        const projectId = `prj_ap_01_${"a".repeat(24)}`;

        await app.createChatBot();
        await app.registerSlackApp();
        const bound = await app.request("/mobius-slack/api/slack/bots/bot-1/binding", {
            method: "PUT",
            headers: jsonHeaders,
            body: JSON.stringify({ botId: "chat-bot-1" }),
        });
        expect(bound.status).toBe(200);

        const manifestResponse = await app.request("/mobius-slack/api/slack/manifest?name=Project%20bot", {
            headers,
        });
        expect(manifestResponse.status).toBe(200);
        const manifest = v.parse(
            v.object({
                oauth_config: v.object({ redirect_urls: v.array(v.string()) }),
                settings: v.object({ event_subscriptions: v.object({ request_url: v.string() }) }),
            }),
            await manifestResponse.json(),
        );
        for (const target of [
            ...manifest.oauth_config.redirect_urls,
            manifest.settings.event_subscriptions.request_url,
        ]) {
            expect(new URL(target).searchParams.get("projectId")).toBe(projectId);
        }

        const me = await app.request("/mobius-slack/api/slack/me", { headers });
        expect(me.status).toBe(200);
        expect(await me.json()).toMatchObject({ humanId: "tenant-1", tenantId: "tenant-1" });

        const bots = await app.request("/mobius-slack/api/slack/bots", { headers });
        expect(bots.status).toBe(200);
        expect(await bots.json()).toEqual({
            bots: [{ id: "bot-1", name: "Test", binding: { kind: "bound", botId: "chat-bot-1" } }],
        });

        const url = await oauthUrl(app);
        expect(url.origin).toBe("https://slack.com");
        expect(url.searchParams.get("client_id")).toBe("client-1");
        expect(url.searchParams.get("scope")).toContain("app_mentions:read");
        expect(url.searchParams.get("scope")).toContain("reactions:write");
        expect(url.searchParams.get("state")).not.toBeNull();

        const completed = await app.request(
            `/mobius-slack/api/slack/oauth/callback?code=oauth-code&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`,
        );
        expect(completed.status).toBe(302);
        expect(completed.headers.get("location")).toBe("/oauth-result?status=success");
        expect(app.slack.messages).toContainEqual({
            channelId: "D:U_INSTALLER",
            text: "Slack is now connected to your Mobius bot.",
            threadTs: null,
            token: "xoxb-token",
        });
        expect(
            (
                await app.request("/mobius-slack/api/slack/status?slackBotId=bot-1", {
                    headers,
                })
            ).status,
        ).toBe(200);

        const registered = await app.request("/mobius-slack/api/slack/apps/register", {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify({
                slackBotId: "bot-1",
                name: "Member app",
                clientId: "client-1",
                clientSecret: "client-secret",
                signingSecret: "signing-secret",
                slackAppId: "A123",
            }),
        });
        expect(registered.status).toBe(201);
        expect(
            (
                await app.request("/mobius-slack/api/slack/apps/bot-1", {
                    method: "DELETE",
                    headers: jsonHeaders,
                })
            ).status,
        ).toBe(204);
        const status = await app.request("/mobius-slack/api/slack/status?slackBotId=bot-1", { headers });
        expect(await status.json()).toMatchObject({ kind: "not-configured" });
    });

    it("Given the Slack management boundary, When inputs, credentials, or OAuth state are invalid, Then each request is rejected", async () => {
        const app = await createTestApplication();
        const headers = await authorization(app);

        const unknownBot = await app.request("/mobius-slack/api/slack/bots/bot-1/binding", {
            method: "PUT",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ botId: "unknown-chat-bot" }),
        });
        expect(unknownBot.status).toBe(400);

        const wrongMedia = await app.request("/mobius-slack/api/slack/bots/bot-1/binding", {
            method: "PUT",
            headers: { ...headers, "content-type": "text/plain" },
            body: JSON.stringify({ botId: "bot-1" }),
        });
        expect(wrongMedia.status).toBe(400);
        expect(await wrongMedia.json()).toEqual({
            error: { code: "INVALID_REQUEST", message: "A JSON request is required." },
        });

        const missingBot = await app.request("/mobius-slack/api/slack/status", { headers });
        expect(missingBot.status).toBe(400);
        expect(await missingBot.json()).toEqual({
            error: { code: "INVALID_REQUEST", message: "Request validation failed" },
        });

        const other = new FakeClerk({ issuer: "https://identity.clerk.accounts.dev" });
        const wrongHost = await app.request("/mobius-slack/api/slack/me", {
            headers: {
                authorization: `Bearer ${other.createSession("user_tenant-1", "https://slack.example.test")}`,
            },
        });
        expect(wrongHost.status).toBe(401);

        await app.registerSlackApp();
        const url = await oauthUrl(app);
        const tampered = await app.request(
            `/mobius-slack/api/slack/oauth/callback?code=oauth-code&state=${encodeURIComponent(`${url.searchParams.get("state")}tampered`)}`,
        );
        expect(tampered.status).toBe(400);
        expect(await tampered.json()).toMatchObject({ error: { code: "INVALID_SLACK_TOKEN" } });
        expect(app.slack.messages).toEqual([]);
    });
});
