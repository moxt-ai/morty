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
    const stored = await app.attachments.apac.get(key, new AbortController().signal);
    expect(await stored?.text()).toBe("Report contents");
});

test("Given tenants with files in different regions, When their downloads run through the same application, Then each receives only its assigned bucket's content", async () => {
    const app = await createTestApplication(true);
    app.tenantShards.assign("tenant-2", { d1ShardId: "wnam-01", r2BucketId: "wnam", revision: 1 });
    const signal = new AbortController().signal;
    const firstKey = "tenant-1/T1/F1/report.txt";
    const secondKey = "tenant-2/T2/F2/report.txt";
    await app.attachments.apac.put(firstKey, new Response("APAC report"), "text/plain", signal);
    await app.attachments.wnam.put(secondKey, new Response("WNAM report"), "text/plain", signal);
    // A wrong bucket contains the same object key, making fallback observable.
    await app.attachments.legacy.put(firstKey, new Response("wrong legacy report"), "text/plain", signal);
    await app.attachments.apac.put(secondKey, new Response("wrong regional report"), "text/plain", signal);

    const [first, second] = await Promise.all([
        app.request(`/mobius-slack/api/files/${encodeURIComponent(firstKey)}`),
        app.request(`/mobius-slack/api/files/${encodeURIComponent(secondKey)}`),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.text()).toBe("APAC report");
    expect(await second.text()).toBe("WNAM report");
});

test("Given a tenant assigned to unavailable storage, When a visitor loads health or an invalid OAuth callback, Then those requests finish without selecting that tenant's storage", async () => {
    const app = await createTestApplication();
    app.tenantShards.assign("tenant-1", { d1ShardId: "unavailable", r2BucketId: "unavailable", revision: 1 });
    const health = await app.request("/mobius-slack/api/health");
    expect(health.status).toBe(200);
    const callback = await app.request("/mobius-slack/api/slack/oauth/callback?code=unused&state=invalid");
    expect(callback.status).toBe(400);
    expect(await callback.json()).toMatchObject({ error: { code: "INVALID_SLACK_TOKEN" } });
    const download = await app.request("/mobius-slack/api/files/tenant-1/T1/F1/report.txt");
    expect(download.status).toBe(503);
    expect(await download.json()).toMatchObject({ error: { code: "SLACK_STORAGE_UNAVAILABLE" } });
});
