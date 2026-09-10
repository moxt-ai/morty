import { describe, expect, it, vi } from "vitest";
import type { SlackEventCallbackPayload } from "../../src/service/events/events";
import { createSignedRequest } from "./signed-request";
import { createTestApplication } from "./test-app";

const event: SlackEventCallbackPayload = {
    api_app_id: "A123",
    event: {
        channel: "C123",
        channel_type: "channel",
        text: "<@U_BOT> investigate",
        ts: "100.0",
        type: "app_mention",
        user: "U123",
    },
    event_id: "Ev123",
    event_time: 1_800_000_000,
    team_id: "T123",
    type: "event_callback",
};
async function send(app: Awaited<ReturnType<typeof createTestApplication>>, payload = event) {
    const response = await app.signedRequest("/mobius-slack/api/slack/events", JSON.stringify(payload));
    expect(response.status).toBe(202);
    expect(app.queueErrors).toEqual([]);
}
describe("Slack message journeys", () => {
    it("Given an active Slack turn, When processing is cancelled, Then cancellation propagates and a later message can run without resubmitting the cancelled turn", async () => {
        const app = await createTestApplication();
        const controller = new AbortController();
        const signedRequest = createSignedRequest((url, init) =>
            app.request(url, { ...init, signal: controller.signal }),
        );
        const gate = app.mobius.pauseNext();
        const pending = signedRequest("/mobius-slack/api/slack/events", JSON.stringify(event));
        await gate.started;
        const reason = new DOMException("Processing cancelled", "AbortError");
        controller.abort(reason);
        await pending;
        expect(app.queueErrors).toEqual([reason]);
        expect(app.slack.messages).toEqual([]);
        app.queueErrors.length = 0;
        await send(app);
        expect(app.mobius.runs).toHaveLength(1);
        await send(app, {
            ...event,
            event_id: "Ev-after-cancel",
            event: { ...event.event, thread_ts: "100.0", ts: "101.0" },
        });
        expect(app.mobius.runs).toHaveLength(2);
        expect(app.slack.messages[0]?.text).toBe("Investigation complete");
        gate.complete();
    });
    it("Given a Slack mention with thread history, When the bot is processing it, Then the prompt reaches the bot without a stored prompt or context-message copy", async () => {
        const app = await createTestApplication();
        app.slack.threadMessages = [
            { botId: null, files: [], text: "private context", threadTs: "99.0", ts: "99.0", userId: "U123" },
        ];
        const gate = app.mobius.pauseNext();
        const pending = send(app, { ...event, event: { ...event.event, thread_ts: "99.0" } });
        await gate.started;
        try {
            expect(app.mobius.runs[0]?.prompt).toContain("private context");
            expect(app.mobius.runs[0]?.prompt).toContain("investigate");
            expect(
                app.database.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'slack_prompt_command'").all(),
            ).toEqual([]);
            const runs = app.database.sqlite.prepare("SELECT * FROM slack_message_delivery").all();
            expect(runs).toHaveLength(1);
            expect(runs[0]).not.toHaveProperty("context_messages");
            expect(JSON.stringify(runs)).not.toContain("private context");
            expect(JSON.stringify(runs)).not.toContain("investigate");
        } finally {
            gate.complete();
            await pending;
        }
        expect(app.slack.messages[0]?.text).toBe("Investigation complete");
    });
    it("Given a stalled bot turn and a waiting message, When the turn times out, Then Slack reports the timeout and processes the waiting message without resubmitting the stalled turn", async () => {
        const app = await createTestApplication();
        const gate = app.mobius.pauseNext();
        const pending = send(app);
        await gate.started;
        await send(app, {
            ...event,
            event_id: "Ev-waiting",
            event: { ...event.event, thread_ts: "100.0", ts: "101.0" },
        });
        await vi.advanceTimersByTimeAsync(600_000);
        await pending;
        expect(app.slack.messages.map((message) => message.text)).toEqual([
            "The bot run failed (MOBIUS_PROMPT_TIMEOUT). Please try again.",
            "Investigation complete",
        ]);
        await send(app);
        expect(app.mobius.runs).toHaveLength(2);
        expect(app.queueErrors).toEqual([]);
        gate.complete();
    });
    it("Given an app stored on a tenant shard, When Slack delivers a signed mention, Then discovery and queued processing produce the bot reply", async () => {
        const app = await createTestApplication(true);
        await send(app);
        expect(app.slack.messages).toHaveLength(1);
        expect(app.slack.messages[0]?.text).toBe("Investigation complete");
        expect(app.mobius.runs).toHaveLength(1);
    });
    it("Given a turn whose connection was lost, When Slack repeats the event and the user sends a new message, Then the failed turn is not recovered and the new message gets a reply", async () => {
        const app = await createTestApplication();
        app.mobius.connectionState = "disconnect-after-result";
        const response = await app.signedRequest("/mobius-slack/api/slack/events", JSON.stringify(event));
        expect(response.status).toBe(202);
        expect(app.queueErrors).toEqual([]);
        expect(app.slack.messages[0]?.text).toBe("The bot run failed (MOBIUS_CONNECTION_FAILED). Please try again.");
        await send(app);
        await send(app);
        expect(app.slack.messages).toHaveLength(1);
        expect(app.mobius.results.size).toBe(1);
        expect(app.mobius.runs).toHaveLength(1);
        await send(app, {
            ...event,
            event_id: "Ev-next",
            event: { ...event.event, thread_ts: "100.0", ts: "101.0" },
        });
        expect(app.slack.messages[1]?.text).toBe("Investigation complete");
        expect(app.mobius.runs).toHaveLength(2);
    });
    it("Given a completed thread turn, When an older event arrives, Then no additional reply is posted", async () => {
        const app = await createTestApplication();
        await send(app);
        await send(app, {
            ...event,
            event_id: "Ev-old",
            event: { ...event.event, thread_ts: "100.0", ts: "99.0" },
        });
        expect(app.slack.messages).toHaveLength(1);
    });
    it("Given a user sends the first direct message, When Slack delivers it, Then a conversation starts", async () => {
        const app = await createTestApplication();
        await send(app, {
            ...event,
            event: {
                ...event.event,
                channel: "D123",
                channel_type: "im",
                type: "message",
                text: "hello",
            },
        });
        expect(app.mobius.runs).toHaveLength(1);
    });
    it("Given an existing thread, When its user continues without mentioning the bot, Then the same conversation is reused", async () => {
        const app = await createTestApplication();
        const first = {
            ...event,
            event: { ...event.event, thread_ts: "99.0" },
        };
        await send(app, first);
        await send(app, {
            ...first,
            event_id: "Ev124",
            event: {
                ...first.event,
                type: "message",
                text: "continue",
                ts: "101.0",
            },
        });
        expect(app.mobius.runs).toHaveLength(2);
        expect(app.mobius.runs[1]?.conversationId).toBe(app.mobius.runs[0]?.conversationId);
    });
    it("Given an independently configured Slack bot, When a workspace user mentions it, Then its bound Mobius bot replies", async () => {
        const app = await createTestApplication();
        const response = await app.request("/mobius-slack/api/slack/apps/register", {
            method: "POST",
            headers: {
                authorization: `Bearer ${await app.humanToken()}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                slackBotId: "bot-1",
                name: "Bot",
                clientId: "client-1",
                clientSecret: "client-secret",
                signingSecret: "signing-secret",
                slackAppId: "A123",
            }),
        });
        expect(response.status).toBe(201);
        app.identity.bots.delete("tenant-1:bot-1");
        await send(app);
        expect(app.slack.ephemeral).toEqual([]);
        expect(app.slack.messages[0]?.text).toBe("Investigation complete");
        expect(app.mobius.runs).toHaveLength(1);
    });
    for (const mode of ["admit", "refuse", "fail"]) {
        it(`Given an authorized source bot and a limiter in ${mode} mode, When its thread mention arrives, Then the trigger budget is respected`, async () => {
            const app = await createTestApplication();
            const response = await app.request("/mobius-slack/api/slack/apps/register", {
                method: "POST",
                headers: {
                    authorization: `Bearer ${await app.humanToken()}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    slackBotId: "bot-source",
                    name: "Source",
                    clientId: "source-client",
                    clientSecret: "source-secret",
                    signingSecret: "source-signing",
                    slackAppId: "A_SOURCE",
                }),
            });
            expect(response.status).toBe(201);
            app.limiter.mode = mode;
            await send(app, {
                ...event,
                event: {
                    ...event.event,
                    bot_id: "B_SOURCE",
                    thread_ts: "99.0",
                },
            });
            expect(app.mobius.runs).toHaveLength(mode === "refuse" ? 0 : 1);
        });
    }
    it("Given an unknown external bot, When it mentions the bot, Then no run starts", async () => {
        const app = await createTestApplication();
        await send(app, {
            ...event,
            event: { ...event.event, bot_id: "B_UNKNOWN", thread_ts: "99.0" },
        });
        expect(app.mobius.runs).toEqual([]);
    });
    it("Given Slack verifies the event URL, When it sends a signed challenge, Then the challenge is returned", async () => {
        const app = await createTestApplication();
        const response = await app.signedRequest(
            "/mobius-slack/api/slack/events",
            JSON.stringify({
                api_app_id: "A123",
                challenge: "challenge-value",
                type: "url_verification",
            }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ challenge: "challenge-value" });
    });
    it("Given a user mentions the bot, When Slack delivers and retries the event, Then one tenant-scoped run starts", async () => {
        const app = await createTestApplication();
        await send(app);
        await send(app);
        expect(app.mobius.runs).toHaveLength(1);
        expect(app.mobius.runs[0]).toMatchObject({
            botId: "mobius-bot-1",
            prompt: "<@U_BOT> investigate",
        });
        expect(
            app.database.sqlite
                .prepare("SELECT payload, status FROM processed_slack_event WHERE slack_event_id = 'Ev123'")
                .get(),
        ).toMatchObject({ payload: "", status: "processed" });
    });
    it("Given an invalid Slack signature, When a message arrives, Then no bot run starts", async () => {
        const app = await createTestApplication();
        expect(
            (
                await app.signedRequest(
                    "/mobius-slack/api/slack/events",
                    JSON.stringify(event),
                    undefined,
                    "wrong-secret",
                )
            ).status,
        ).toBe(401);
        expect(app.mobius.runs).toEqual([]);
    });
    it("Given a request older than five minutes, When Slack sends it, Then replay protection rejects it", async () => {
        const app = await createTestApplication();
        expect(
            (
                await app.signedRequest(
                    "/mobius-slack/api/slack/events",
                    JSON.stringify(event),
                    Math.floor(Date.now() / 1_000) - 301,
                )
            ).status,
        ).toBe(401);
        expect(app.mobius.runs).toEqual([]);
    });
    it("Given a channel message without a mention, When Slack delivers it, Then no reply or run starts", async () => {
        const app = await createTestApplication();
        await send(app, {
            ...event,
            event: { ...event.event, type: "message", text: "hello channel" },
        });
        expect(app.mobius.runs).toEqual([]);
        expect(app.slack.messages).toEqual([]);
    });
    it("Given a thread mention, When Slack delivers it, Then the bot sees ordered history without its trigger duplicated", async () => {
        const app = await createTestApplication();
        const message = (ts: string, text: string) => ({
            botId: null,
            files: [],
            text,
            threadTs: null,
            ts,
            userId: "U123",
        });
        app.slack.channelMessages = [message("1.0", "channel context")];
        app.slack.threadMessages = [message("100.0", "trigger"), message("2.0", "thread context")];
        const payload = {
            ...event,
            event: { ...event.event, thread_ts: "1.5" },
        };
        await send(app, payload);
        expect(app.mobius.runs[0]?.prompt).toBe(
            "# Channel history:\n[1.0] U123: channel context\n\n# Thread messages:\n[2.0] U123: thread context\n\n<@U_BOT> investigate",
        );
    });
    it("Given a bot run and a waiting message, When completion arrives, Then Slack gets the reply and the waiting message resumes", async () => {
        const app = await createTestApplication();
        const gate = app.mobius.pauseNext();
        const first = send(app);
        await gate.started;
        await send(app, {
            ...event,
            event_id: "Ev124",
            event: { ...event.event, ts: "101.0", thread_ts: "100.0" },
        });
        expect(
            app.database.sqlite
                .prepare("SELECT payload FROM processed_slack_event WHERE slack_event_id = 'Ev124'")
                .get()?.["payload"],
        ).toContain("Ev124");
        gate.complete();
        await first;
        expect(app.slack.messages).toHaveLength(2);
        expect(app.slack.messages.every((message) => message.threadTs === "100.0")).toBe(true);
        expect(app.queueErrors).toEqual([]);
        expect(app.mobius.runs).toHaveLength(2);
        expect(app.database.sqlite.prepare("SELECT payload FROM processed_slack_event").all()).toEqual([
            { payload: "" },
            { payload: "" },
        ]);
    });
    it("Given an intentional NO_REPLY result, When completion arrives, Then no Slack reply is posted", async () => {
        const app = await createTestApplication();
        app.mobius.responseText = " [NO_REPLY] ";
        await send(app);
        expect(app.slack.messages).toEqual([]);
    });
    it("Given a completed turn, When its original event is retried, Then no duplicate reply is posted", async () => {
        const app = await createTestApplication();
        await send(app);
        await send(app);
        expect(app.slack.messages).toHaveLength(1);
    });
    it("Given an authenticated bot, When it sends a thread message through its tool URL, Then its installation token delivers the message", async () => {
        const app = await createTestApplication();
        const response = await app.request("/mobius-slack/api/bot/slack/messages", {
            method: "POST",
            headers: {
                authorization: "Bearer test-bot",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                channelId: "C123",
                text: "Done",
                threadTs: "100.0",
                tenantId: "tenant-2",
            }),
        });
        expect(response.status).toBe(200);
        expect(app.slack.messages).toEqual([
            {
                channelId: "C123",
                text: "Done",
                threadTs: "100.0",
                token: "xoxb-token",
            },
        ]);
    });
});
