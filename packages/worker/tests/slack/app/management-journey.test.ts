import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { InMemoryClerkGateway } from "./in-memory-clerk-gateway";
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
    it("Given a Project workspace, When its Slack manifest is requested, Then events and OAuth callbacks retain the Project context", async () => {
        const app = await createTestApplication();
        const response = await app.request("/mobius-slack/api/slack/manifest?name=Project%20bot", {
            headers: await authorization(app),
        });
        expect(response.status).toBe(200);
        const manifest = v.parse(
            v.object({
                oauth_config: v.object({ redirect_urls: v.array(v.string()) }),
                settings: v.object({ event_subscriptions: v.object({ request_url: v.string() }) }),
            }),
            await response.json(),
        );
        for (const target of [
            ...manifest.oauth_config.redirect_urls,
            manifest.settings.event_subscriptions.request_url,
        ]) {
            expect(new URL(target).searchParams.get("projectId")).toBe(`prj_a01_${"a".repeat(24)}`);
        }
    });
    it("Given an authenticated user, When they list bots and complete OAuth, Then their configured bots and connection are visible", async () => {
        const app = await createTestApplication();
        const headers = { authorization: `Bearer ${await app.humanToken("tenant-1")}` };
        const bots = await app.request("/mobius-slack/api/slack/bots", { headers });
        expect(bots.status).toBe(200);
        expect(await bots.json()).toMatchObject({
            bots: expect.arrayContaining([
                { id: "bot-1", name: "Test", binding: { kind: "bound", botId: "mobius-bot-1" } },
            ]),
        });
        const start = await app.request("/mobius-slack/api/slack/oauth/url?slackBotId=bot-1", { headers });
        expect(start.status).toBe(200);
        const url = new URL(v.parse(v.object({ url: v.string() }), await start.json()).url);
        const state = url.searchParams.get("state");
        const completed = await app.request(
            `/mobius-slack/api/slack/oauth/callback?code=oauth-code&state=${encodeURIComponent(state ?? "")}`,
        );
        expect(completed.status).toBe(302);
        expect(completed.headers.get("Location")).toBe("/oauth-result?status=success");
        const status = await app.request("/mobius-slack/api/slack/status?slackBotId=bot-1", { headers });
        expect(status.status).toBe(200);
    });
    it("Given an existing Slack bot, When an invalid connection grant is supplied, Then the binding request is rejected", async () => {
        const app = await createTestApplication();
        const response = await app.request("/mobius-slack/api/slack/bots/bot-1/binding", {
            method: "PUT",
            headers: { ...(await authorization(app)), "Content-Type": "application/json" },
            body: JSON.stringify({ botId: "bot-1", ownerCredential: "s".repeat(32) }),
        });
        expect(response.status).toBe(502);
    });
    it("Given an authenticated user, When a Slack API body is not JSON media, Then the request is rejected", async () => {
        const app = await createTestApplication();
        const response = await app.request("/mobius-slack/api/slack/bots/bot-1/binding", {
            method: "PUT",
            headers: { ...(await authorization(app)), "content-type": "text/plain" },
            body: JSON.stringify({ botId: "bot-1", ownerCredential: "s".repeat(32) }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            error: { code: "INVALID_REQUEST", message: "A JSON request is required." },
        });
    });
    it("Given a signed-in user, When the dashboard loads bots, Then it shows only that user's configured bots", async () => {
        const app = await createTestApplication();
        const response = await app.request("/mobius-slack/api/slack/bots", { headers: await authorization(app) });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            bots: [{ id: "bot-1", name: "Test", binding: { kind: "bound", botId: "mobius-bot-1" } }],
        });
    });
    it("Given a signed-in user, When they register and disconnect a bot's Slack app, Then both operations succeed", async () => {
        const app = await createTestApplication();
        const headers = {
            authorization: `Bearer ${await app.humanToken("tenant-1")}`,
            "Content-Type": "application/json",
        };
        const registered = await app.request("/mobius-slack/api/slack/apps/register", {
            method: "POST",
            headers,
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
        const disconnected = await app.request("/mobius-slack/api/slack/apps/bot-1", { method: "DELETE", headers });
        expect(disconnected.status).toBe(204);
        const status = await app.request("/mobius-slack/api/slack/status?slackBotId=bot-1", { headers });
        expect(await status.json()).toMatchObject({ kind: "not-configured" });
    });
    it("Given a signed-in user, When they start Slack OAuth, Then installation is allowed", async () => {
        const app = await createTestApplication();
        const response = await app.request("/mobius-slack/api/slack/oauth/url?slackBotId=bot-1", {
            headers: { authorization: `Bearer ${await app.humanToken("tenant-1")}` },
        });
        expect(response.status).toBe(200);
    });
    it("Given the application is running, When a user requests health, Then readiness is returned", async () => {
        const app = await createTestApplication();
        const response = await app.request("/mobius-slack/api/health");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            service: "app-slack",
            status: "ok",
        });
    });
    it("Given a host-authenticated user session, When the user opens their profile, Then their user identity is returned", async () => {
        const app = await createTestApplication();
        const response = await app.request("/mobius-slack/api/slack/me", {
            headers: await authorization(app),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            humanId: "tenant-1",
            tenantId: "tenant-1",
        });
    });
    it("Given a credential from another host, When a user opens their profile, Then access is rejected", async () => {
        const app = await createTestApplication();
        const other = new InMemoryClerkGateway();
        expect(
            (
                await app.request("/mobius-slack/api/slack/me", {
                    headers: {
                        authorization: `Bearer ${await other.humanToken()}`,
                    },
                })
            ).status,
        ).toBe(401);
    });
    it("Given a configured bot, When its owner starts OAuth, Then the authorization URL includes scopes and signed state", async () => {
        const app = await createTestApplication();
        const url = await oauthUrl(app);
        expect(url.origin).toBe("https://slack.com");
        expect(url.searchParams.get("client_id")).toBe("client-1");
        expect(url.searchParams.get("scope")).toContain("app_mentions:read");
        expect(url.searchParams.get("scope")).toContain("reactions:write");
        expect(url.searchParams.get("state")).not.toBeNull();
    });
    it("Given Slack returns the authorization code, When the user follows the callback, Then the installation is connected and a welcome DM arrives", async () => {
        const app = await createTestApplication();
        const url = await oauthUrl(app);
        const response = await app.request(
            `/mobius-slack/api/slack/oauth/callback?code=oauth-code&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`,
        );
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/oauth-result?status=success");
        expect(app.slack.messages).toContainEqual({
            channelId: "D:U_INSTALLER",
            text: "Slack is now connected to your Mobius bot.",
            threadTs: null,
            token: "xoxb-token",
        });
        expect(
            (
                await app.request("/mobius-slack/api/slack/status?slackBotId=bot-1", {
                    headers: await authorization(app),
                })
            ).status,
        ).toBe(200);
    });
    it("Given modified OAuth state, When the callback is opened, Then the token is rejected without a welcome message", async () => {
        const app = await createTestApplication();
        const url = await oauthUrl(app);
        const response = await app.request(
            `/mobius-slack/api/slack/oauth/callback?code=oauth-code&state=${encodeURIComponent(`${url.searchParams.get("state")}tampered`)}`,
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
            error: { code: "INVALID_SLACK_TOKEN" },
        });
        expect(app.slack.messages).toEqual([]);
    });
    it("Given a Slack user without a linked account, When they mention an installed bot, Then they receive a reply directly", async () => {
        const app = await createTestApplication();
        const event = {
            api_app_id: "A123",
            event: {
                type: "app_mention",
                channel: "C123",
                channel_type: "channel",
                ts: "100.0",
                text: "<@U_BOT> help",
                user: "U_NEW",
            },
            event_id: "EvNew",
            event_time: 1_800_000_000,
            team_id: "T123",
            type: "event_callback",
        };
        expect((await app.signedRequest("/mobius-slack/api/slack/events", JSON.stringify(event))).status).toBe(202);
        expect(app.queueErrors).toEqual([]);
        expect(app.mobius.runs).toHaveLength(1);
        expect(app.slack.messages[0]?.text).toBe("Investigation complete");
    });
    it("Given missing bot query parameters, When a user requests status, Then validation returns a sanitized response", async () => {
        const app = await createTestApplication();
        const response = await app.request("/mobius-slack/api/slack/status", {
            headers: await authorization(app),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            error: {
                code: "INVALID_REQUEST",
                message: "Request validation failed",
            },
        });
    });
});
