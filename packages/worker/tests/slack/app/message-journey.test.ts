import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it, vi } from "vitest";
import type { SlackEventCallbackPayload } from "../../../src/components/slack/service/events/events";
import { processedSlackEvent, slackMessageDelivery } from "../../../src/schema/d1/index.ts";
import { createSignedRequest } from "./signed-request";
import { createConnectedTestApplication } from "./test-app";

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

const sqliteMaster = sqliteTable("sqlite_master", {
    name: text("name"),
});

type TestApplication = Awaited<ReturnType<typeof createConnectedTestApplication>>;

async function send(app: TestApplication, payload = event) {
    const response = await app.signedRequest("/mobius-slack/api/slack/events", JSON.stringify(payload));
    expect(response.status).toBe(202);
    expect(app.queueErrors).toEqual([]);
}

async function registerSourceApp(app: TestApplication) {
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
}

describe("Slack message journeys", () => {
    it("Given an active Slack turn, When it is cancelled and another message arrives, Then only the new message completes", async () => {
        const app = await createConnectedTestApplication();
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
        await send(app, {
            ...event,
            event_id: "Ev-after-cancel",
            event: { ...event.event, thread_ts: "100.0", ts: "101.0" },
        });
        expect(app.mobius.runs).toHaveLength(2);
        expect(app.slack.messages[0]?.text).toBe("Investigation complete");
        gate.complete();
    });

    it("Given a connected Slack app, When channel, thread, retry, and direct messages arrive, Then ordering and privacy are preserved", async () => {
        const app = await createConnectedTestApplication();
        const message = (ts: string, text: string) => ({
            botId: null,
            files: [],
            text,
            threadTs: null,
            ts,
            userId: "U123",
        });
        app.slack.channelMessages = [message("1.0", "channel context")];
        app.slack.threadMessages = [message("100.0", "trigger"), message("2.0", "private context")];
        const first = { ...event, event: { ...event.event, thread_ts: "1.5" } };

        await send(app, first);
        expect(app.mobius.runs[0]).toMatchObject({
            botId: "chat-bot-1",
            instructions: "Answer as the configured Chat Bot.",
            prompt: "# Channel history:\n[1.0] U123: channel context\n\n# Thread messages:\n[2.0] U123: private context\n\n<@U_BOT> investigate",
        });
        expect(
            await app.database.orm
                .select({ name: sqliteMaster.name })
                .from(sqliteMaster)
                .where(eq(sqliteMaster.name, "slack_prompt_command")),
        ).toEqual([]);
        const deliveries = await app.database.orm.select().from(slackMessageDelivery);
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]).not.toHaveProperty("context_messages");
        expect(JSON.stringify(deliveries)).not.toContain("private context");
        expect(JSON.stringify(deliveries)).not.toContain("investigate");
        expect(app.slack.messages[0]?.text).toBe("Investigation complete");

        await send(app, first);
        await send(app, {
            ...first,
            event_id: "Ev-old",
            event: { ...first.event, ts: "0.5" },
        });
        expect(app.mobius.runs).toHaveLength(1);
        expect(app.slack.messages).toHaveLength(1);
        expect(
            await app.database.orm
                .select({ payload: processedSlackEvent.payload, status: processedSlackEvent.status })
                .from(processedSlackEvent)
                .where(eq(processedSlackEvent.slackEventId, "Ev123"))
                .get(),
        ).toMatchObject({ payload: "", status: "processed" });

        await send(app, {
            ...first,
            event_id: "Ev-thread-follow-up",
            event: { ...first.event, type: "message", text: "continue", ts: "101.0" },
        });
        expect(app.mobius.runs[1]?.conversationId).toBe(app.mobius.runs[0]?.conversationId);

        await send(app, {
            ...event,
            event_id: "Ev-direct-message",
            event: {
                ...event.event,
                channel: "D123",
                channel_type: "im",
                type: "message",
                text: "hello",
                ts: "200.0",
            },
        });
        expect(app.mobius.runs).toHaveLength(3);
    });

    it("Given a stalled Slack turn, When it times out, Then its waiting message resumes", async () => {
        const app = await createConnectedTestApplication();
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
        gate.complete();
    });

    it("Given an app stored in Cloud D1, When its queued message runs, Then the app is discovered and replies", async () => {
        const app = await createConnectedTestApplication();
        await send(app);
        expect(app.slack.messages[0]?.text).toBe("Investigation complete");
        expect(app.mobius.runs).toHaveLength(1);
    });

    it("Given a disconnected result, When the next Slack message arrives, Then the lost result is not replayed and new work continues", async () => {
        const app = await createConnectedTestApplication();
        app.mobius.connectionState = "disconnect-after-result";
        await send(app);
        expect(app.slack.messages[0]?.text).toBe("The bot run failed (MOBIUS_CONNECTION_FAILED). Please try again.");

        await send(app);
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

    it("Given an independently configured Slack app, When it receives a message, Then it replies without a linked user identity", async () => {
        const app = await createConnectedTestApplication();
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

    it("Given one Slack installation, When every source-Bot limiter outcome occurs, Then each message follows its decision", async () => {
        const app = await createConnectedTestApplication();
        await registerSourceApp(app);
        for (const [index, mode] of ["admit", "refuse", "fail"].entries()) {
            app.limiter.mode = mode;
            const runsBefore = app.mobius.runs.length;
            await send(app, {
                ...event,
                event_id: `Ev-limiter-${mode}`,
                event: {
                    ...event.event,
                    bot_id: "B_SOURCE",
                    thread_ts: "99.0",
                    ts: `${110 + index}.0`,
                },
            });
            expect(app.mobius.runs).toHaveLength(runsBefore + (mode === "refuse" ? 0 : 1));
        }
    });

    it("Given the Slack event boundary, When unauthenticated, stale, irrelevant, or unknown-Bot events arrive, Then each is rejected", async () => {
        const app = await createConnectedTestApplication();
        const challenge = await app.signedRequest(
            "/mobius-slack/api/slack/events",
            JSON.stringify({ api_app_id: "A123", challenge: "challenge-value", type: "url_verification" }),
        );
        expect(challenge.status).toBe(200);
        expect(await challenge.json()).toEqual({ challenge: "challenge-value" });

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
        expect(
            (
                await app.signedRequest(
                    "/mobius-slack/api/slack/events",
                    JSON.stringify(event),
                    Math.floor(Date.now() / 1_000) - 301,
                )
            ).status,
        ).toBe(401);
        await send(app, {
            ...event,
            event_id: "Ev-no-mention",
            event: { ...event.event, type: "message", text: "hello channel", ts: "101.0" },
        });
        await send(app, {
            ...event,
            event_id: "Ev-unknown-bot",
            event: { ...event.event, bot_id: "B_UNKNOWN", thread_ts: "99.0", ts: "102.0" },
        });
        expect(app.mobius.runs).toEqual([]);
        expect(app.slack.messages).toEqual([]);
    });

    it("Given a waiting Slack event, When the active turn completes, Then the event resumes and its payload is cleared", async () => {
        const app = await createConnectedTestApplication();
        const gate = app.mobius.pauseNext();
        const first = send(app);
        await gate.started;
        await send(app, {
            ...event,
            event_id: "Ev124",
            event: { ...event.event, ts: "101.0", thread_ts: "100.0" },
        });
        const stored = await app.database.orm
            .select({ payload: processedSlackEvent.payload })
            .from(processedSlackEvent)
            .where(eq(processedSlackEvent.slackEventId, "Ev124"))
            .get();
        expect(stored?.payload).toContain("Ev124");

        gate.complete();
        await first;
        expect(app.slack.messages).toHaveLength(2);
        expect(app.slack.messages.every((message) => message.threadTs === "100.0")).toBe(true);
        expect(app.mobius.runs).toHaveLength(2);
        expect(
            await app.database.orm.select({ payload: processedSlackEvent.payload }).from(processedSlackEvent),
        ).toEqual([{ payload: "" }, { payload: "" }]);
    });

    it("Given Slack reply and tool delivery, When the Agent returns NO_REPLY, Then chat is suppressed but authenticated tools still work", async () => {
        const app = await createConnectedTestApplication();
        app.mobius.responseText = " [NO_REPLY] ";
        await send(app);
        expect(app.slack.messages).toEqual([]);

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
            { channelId: "C123", text: "Done", threadTs: "100.0", token: "xoxb-token" },
        ]);
    });
});
