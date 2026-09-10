import { expect, it } from "vitest";
import { createTestApplication } from "./test-app";

it("Given no Mobius binding, When a member registers a Slack bot, Then the bot is available for installation and shown as unbound", async () => {
    const app = await createTestApplication();
    const headers = { authorization: `Bearer ${await app.humanToken()}`, "Content-Type": "application/json" };
    const response = await app.request("/mobius-slack/api/slack/apps/register", {
        method: "POST",
        headers,
        body: JSON.stringify({
            slackBotId: "slack-independent",
            name: "Independent",
            clientId: "client-new",
            clientSecret: "secret",
            signingSecret: "signing",
            slackAppId: "A_NEW",
        }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
        oauthAuthorizeUrl: expect.stringContaining("https://slack.com/oauth/v2/authorize"),
    });
    const list = await app.request("/mobius-slack/api/slack/bots", { headers });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
        bots: expect.arrayContaining([{ id: "slack-independent", name: "Independent", binding: { kind: "unbound" } }]),
    });
});

it("Given a Slack bot bound to Mobius, When its owner changes the binding, Then the same Slack installation uses the new bot and a separate conversation", async () => {
    const app = await createTestApplication();
    const headers = { authorization: `Bearer ${await app.humanToken()}`, "Content-Type": "application/json" };
    const send = async (eventId: string, ts: string) => {
        const response = await app.signedRequest(
            "/mobius-slack/api/slack/events",
            JSON.stringify({
                api_app_id: "A123",
                team_id: "T123",
                type: "event_callback",
                event_id: eventId,
                event_time: 1_800_000_000,
                event: {
                    channel: "C123",
                    channel_type: "channel",
                    thread_ts: "99.0",
                    text: "<@U_BOT> help",
                    ts,
                    type: "app_mention",
                    user: "U123",
                },
            }),
        );
        expect(response.status).toBe(202);
        expect(app.queueErrors).toEqual([]);
    };
    await send("binding-before", "100.0");
    const response = await app.request("/mobius-slack/api/slack/bots/bot-1/binding", {
        method: "PUT",
        headers,
        body: JSON.stringify(app.mobius.ownBot("mobius-bot-2")),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "bound", botId: "mobius-bot-2" });
    await send("binding-after", "101.0");
    expect(app.mobius.runs.map((run) => run.botId)).toEqual(["mobius-bot-1", "mobius-bot-2"]);
    expect(app.mobius.runs[1]?.conversationId).not.toBe(app.mobius.runs[0]?.conversationId);
    expect(app.slack.messages.map((message) => message.text)).toEqual([
        "Investigation complete",
        "Investigation complete",
    ]);
    const status = await app.request("/mobius-slack/api/slack/status?slackBotId=bot-1", { headers });
    expect(await status.json()).toMatchObject({ kind: "connected", slackAppId: "A123", slackTeamId: "T123" });
});

it("Given an existing binding, When another bot's owner credential is submitted, Then the replacement is rejected and the existing bot remains bound", async () => {
    const app = await createTestApplication();
    const headers = { authorization: `Bearer ${await app.humanToken()}`, "Content-Type": "application/json" };
    const response = await app.request("/mobius-slack/api/slack/bots/bot-1/binding", {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...app.mobius.ownBot("other-bot"), botId: "mobius-bot-1" }),
    });
    expect(response.status).toBe(502);
    const list = await app.request("/mobius-slack/api/slack/bots", { headers });
    expect(await list.json()).toMatchObject({
        bots: [{ id: "bot-1", binding: { kind: "bound", botId: "mobius-bot-1" } }],
    });
});
