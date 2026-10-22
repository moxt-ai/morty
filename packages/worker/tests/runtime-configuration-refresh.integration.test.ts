import * as v from "valibot";
import { afterEach, test as baseTest, beforeEach, expect, vi } from "vitest";
import worker from "../src/application.ts";
import { APP_ORIGIN, AUTH_TIME, createIdentityFixture } from "./support/identity-fixture.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AUTH_TIME);
});
afterEach(() => vi.useRealTimers());

const test = baseTest.extend<{ readonly cloud: Awaited<ReturnType<typeof createIdentityFixture>> }>({
    cloud: [
        // biome-ignore lint/correctness/noEmptyPattern: Vitest fixtures declare their dependencies by destructuring.
        async ({}, use) => {
            const cloud = await createIdentityFixture();
            try {
                await use(cloud);
            } finally {
                await cloud.close();
            }
        },
        { scope: "file" },
    ],
});

const runtimeConfigurationSchema = v.strictObject({
    runtime: v.strictObject({
        runtimeId: v.string(),
        machineName: v.string(),
        online: v.boolean(),
        agents: v.array(v.strictObject({ agentRef: v.string(), label: v.string() })),
    }),
});

test("Given a configured Bot whose Runtime started without Pi, When its harness list is refreshed, Then the refreshed configuration offers Pi and ordinary reads serve it too", {
    timeout: 60_000,
}, async ({ cloud }) => {
    const identity = await cloud.createAnonymousUser();
    const runtime = await cloud.connectAgent(identity.projectId, [{ id: "codex", label: "Codex" }]);
    const environment = cloud.environment();
    const request = (path: string, body?: object, method = body === undefined ? "GET" : "POST") =>
        worker.fetch(
            new Request(
                `${APP_ORIGIN}/morty/api/${path.startsWith("chat/") ? path.replace("chat/", `chat/projects/${identity.projectId}/`) : `projects/${identity.projectId}/${path}`}`,
                {
                    method,
                    headers: {
                        authorization: `Bearer ${identity.token}`,
                        "content-type": "application/json",
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                },
            ),
            environment,
        );
    const listed = await request("management/bots");
    const { bots } = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await listed.json());
    const botId = v.parse(v.string(), bots[0]?.botId);
    const botRequest = (path: string, body?: object, method = body === undefined ? "GET" : "POST") =>
        request(`chat/bots/${botId}/${path}`, body, method);

    // The Bot is configured on the only harness the Runtime started with.
    expect((await botRequest("setup", { runtimeId: runtime.runtimeId, agentRef: "codex" })).status).toBe(202);
    const initial = await botRequest("workspace", {});
    expect(initial.status).toBe(200);
    expect(v.parse(runtimeConfigurationSchema, await initial.json())).toMatchObject({
        runtime: { runtimeId: runtime.runtimeId, agents: [{ agentRef: "codex" }] },
    });

    // A harness installed after the daemon started stays invisible until the refresh runs.
    await runtime.installAgent({ id: "pi", label: "Pi" });
    const stale = v.parse(runtimeConfigurationSchema, await (await botRequest("workspace", {})).json());
    expect(stale.runtime.agents.map((agent) => agent.agentRef)).toEqual(["codex"]);

    const refreshedResponse = await botRequest("workspace/refresh", {});
    expect(refreshedResponse.status).toBe(200);
    expect(
        v.parse(
            v.strictObject({
                runtime: v.strictObject({
                    runtimeId: v.string(),
                    agents: v.array(v.strictObject({ agentRef: v.string(), label: v.string() })),
                }),
            }),
            await refreshedResponse.json(),
        ),
    ).toMatchObject({ runtime: { agents: [{ agentRef: "codex" }, { agentRef: "pi" }] } });

    // The daemon republished, so ordinary reads stop serving the boot-time set.
    const reread = v.parse(runtimeConfigurationSchema, await (await botRequest("workspace", {})).json());
    expect(reread.runtime.agents.map((agent) => agent.agentRef).sort()).toEqual(["codex", "pi"]);

    await runtime[Symbol.asyncDispose]();
});
