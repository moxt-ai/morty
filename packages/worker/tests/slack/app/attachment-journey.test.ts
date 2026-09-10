import { expect, test } from "vitest";
import { createTestApplication } from "./test-app";

test("Given a Slack message with an attachment, When the bot receives its file link, Then the file is downloadable from the three-day retention namespace", async () => {
    const app = await createTestApplication(true);
    app.slack.files.set("https://files.slack.test/report", "Report contents");
    const response = await app.signedRequest(
        "/mobius-slack/api/slack/events",
        JSON.stringify({
            api_app_id: "A123",
            team_id: "T123",
            event_id: "Ev-file",
            event_time: 1_800_000_000,
            type: "event_callback",
            event: {
                channel: "C123",
                channel_type: "channel",
                text: "<@U_BOT> read this",
                ts: "100.0",
                type: "app_mention",
                user: "U123",
                files: [
                    {
                        id: "F123",
                        name: "report.txt",
                        mimetype: "text/plain",
                        url_private: "https://files.slack.test/report",
                    },
                ],
            },
        }),
    );
    expect(response.status).toBe(202);
    expect(app.queueErrors).toEqual([]);
    const key = "slack-attachments/tenant-1/T123/F123/report.txt";
    const path = `/mobius-slack/api/files/${encodeURIComponent(key)}`;
    expect(app.mobius.runs[0]?.prompt).toContain(path);
    const file = await app.request(path);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("Report contents");
    const stored = await app.attachments.bucket.get(key, new AbortController().signal);
    expect(await stored?.text()).toBe("Report contents");
});

test("Given users with files in one bucket, When downloads use different user prefixes, Then each receives only its own object", async () => {
    const app = await createTestApplication();
    const signal = new AbortController().signal;
    const firstKey = "tenant-1/T1/F1/report.txt";
    const secondKey = "tenant-2/T2/F2/report.txt";
    await app.attachments.bucket.put(firstKey, new Response("First report"), "text/plain", signal);
    await app.attachments.bucket.put(secondKey, new Response("Second report"), "text/plain", signal);

    const [first, second] = await Promise.all([
        app.request(`/mobius-slack/api/files/${encodeURIComponent(firstKey)}`),
        app.request(`/mobius-slack/api/files/${encodeURIComponent(secondKey)}`),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.text()).toBe("First report");
    expect(await second.text()).toBe("Second report");
});
