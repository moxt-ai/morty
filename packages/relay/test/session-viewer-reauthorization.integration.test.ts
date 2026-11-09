import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import * as v from "valibot";
import { afterAll, expect, it } from "vitest";
import { createTestMortyPlatformApp } from "../../platform-test-support/src/app.ts";
import { revokeMortyCredential, seedMortyService } from "../../platform-test-support/src/service-fixture.ts";
import { createPlatformGateways, PlatformAuthenticationConfiguration } from "../src/worker.ts";
import { registerRuntimeFixture } from "./registered-runtime.ts";

const origin = `https://platform.test${MORTY_API_PREFIX}`;

afterAll(async () => await abortAllDurableObjects());

class Inbox {
    readonly #pending: PromiseWithResolvers<Record<string, unknown>>[] = [];
    readonly #queued: Record<string, unknown>[] = [];
    #closed: { code: number; reason: string } | undefined;
    readonly closed = Promise.withResolvers<{ code: number; reason: string }>();
    constructor(socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data));
            const pending = this.#pending.shift();
            if (pending === undefined) {
                this.#queued.push(message);
            } else {
                pending.resolve(message);
            }
        });
        socket.addEventListener("close", (event) => {
            this.#closed = { code: event.code, reason: event.reason };
            this.closed.resolve(this.#closed);
            for (const pending of this.#pending.splice(0)) {
                pending.reject(new Error(`closed ${event.code} ${event.reason}`));
            }
        });
    }
    readonly next = (): Promise<Record<string, unknown>> => {
        const message = this.#queued.shift();
        if (message !== undefined) {
            return Promise.resolve(message);
        }
        if (this.#closed !== undefined) {
            return Promise.reject(new Error("closed"));
        }
        const pending = Promise.withResolvers<Record<string, unknown>>();
        this.#pending.push(pending);
        return pending.promise;
    };
}

async function openSessionView(slug: string) {
    const worker = createTestMortyPlatformApp(new PlatformAuthenticationConfiguration(), createPlatformGateways);
    const { defaultCredential } = await seedMortyService(env.PLATFORM_DIRECTORY_DATABASE);
    const headers = {
        authorization: `Bearer ${defaultCredential.credential}`,
        "content-type": "application/json",
    };
    const dashboard = async (path: string, body?: object) =>
        await worker.fetch(
            new Request(`${origin}/dashboard/v1/${path}`, {
                headers,
                ...(body === undefined ? {} : { body: JSON.stringify(body), method: "POST" }),
            }),
            env,
        );
    const { projectId } = v.parse(
        v.object({ projectId: v.string() }),
        await (
            await dashboard("machine-accounts", {
                displayName: `Viewer check Project ${slug}`,
                idempotencyKey: `viewer-check-project-${slug}`,
                locationHint: "apac",
            })
        ).json(),
    );
    const runtimeId = `viewer-check-runtime-${slug}`;
    const sessionId = "viewer-check-session";
    await registerRuntimeFixture(projectId, runtimeId);
    const daemonResponse = await env.RUNTIME_RELAY.getByName(runtimeId).fetch(
        `https://runtime.internal/projects/${projectId}/daemon`,
        { headers: { Upgrade: "websocket", "x-morty-channel-id": runtimeId, "x-morty-runtime-id": runtimeId } },
    );
    expect(daemonResponse.status).toBe(101);
    const daemon = daemonResponse.webSocket;
    if (daemon === null) {
        throw new Error("Expected a daemon connection");
    }
    const daemonInbox = new Inbox(daemon);
    daemon.accept();
    expect(await daemonInbox.next()).toEqual({ kind: "runtime.liveness.ready" });

    const issued = await worker.fetch(
        new Request(`${origin}/v1/projects/${projectId}/sessions/${sessionId}/access-credentials`, {
            method: "POST",
            headers: { authorization: `Bearer ${defaultCredential.credential}`, "content-type": "application/json" },
            body: JSON.stringify({ expiresInSeconds: 900, runtimeId }),
        }),
        env,
    );
    expect(issued.status).toBe(201);
    const { credential: sessionCredential } = v.parse(v.object({ credential: v.string() }), await issued.json());

    const opened = await worker.fetch(
        new Request(`${origin}/v1/projects/${projectId}/sessions/${sessionId}/events-v2`, {
            headers: { authorization: `Bearer ${sessionCredential}`, Upgrade: "websocket" },
        }),
        env,
    );
    expect(opened.status).toBe(101);
    const view = opened.webSocket;
    if (view === null) {
        throw new Error("Expected a live Session view");
    }
    const viewInbox = new Inbox(view);
    view.accept();

    return { daemon, dashboard, defaultCredential, projectId, runtimeId, sessionId, viewInbox };
}

const liveEvent = (sessionId: string, eventId: string) => ({
    eventId,
    position: "1",
    recordedAt: new Date().toISOString(),
    sessionGenerationId: "generation-1",
    sessionId,
    type: "acp",
    payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "secret output" } },
});

it("Given a live Session view, When the AppCredential that issued its Session credential is revoked, Then the Relay's next connection check closes the view", async () => {
    const { daemon, defaultCredential, runtimeId, sessionId, viewInbox } = await openSessionView("app");
    daemon.send(JSON.stringify({ kind: "session.event.v2", events: [liveEvent(sessionId, "before-revocation")] }));
    expect(await viewInbox.next()).toMatchObject([{ eventId: "before-revocation" }]);

    await revokeMortyCredential(env.PLATFORM_DIRECTORY_DATABASE, defaultCredential.credentialId);
    expect(await runDurableObjectAlarm(env.RUNTIME_RELAY.getByName(runtimeId))).toBe(true);

    expect(await viewInbox.closed.promise).toEqual({ code: 1008, reason: "Session access revoked" });
    daemon.close(1000, "done");
});

it("Given a live Session view the revocation push missed, When the Project's Session access revocation is committed, Then the Relay's next connection check closes the view", async () => {
    const { daemon, projectId, runtimeId, sessionId, viewInbox } = await openSessionView("missed");
    daemon.send(JSON.stringify({ kind: "session.event.v2", events: [liveEvent(sessionId, "before-revocation")] }));
    expect(await viewInbox.next()).toMatchObject([{ eventId: "before-revocation" }]);

    // The revocation commits, but its push never reaches this Runtime's Relay (or reached it before the view opened).
    await env.PLATFORM_DIRECTORY_DATABASE.prepare(
        "INSERT INTO machine_access_revocations (account_id, revoked_at) VALUES (?, ?)",
    )
        .bind(projectId, Date.now())
        .run();
    expect(await runDurableObjectAlarm(env.RUNTIME_RELAY.getByName(runtimeId))).toBe(true);

    expect(await viewInbox.closed.promise).toEqual({ code: 1008, reason: "Session access revoked" });
    daemon.close(1000, "done");
});
