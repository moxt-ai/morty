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

it("Given a quiet /host connection opened with an AppCredential, When the AppCredential is revoked, Then the Relay's next connection check closes it", async () => {
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
                displayName: "Repro8 Project",
                idempotencyKey: "repro8-project",
                locationHint: "apac",
            })
        ).json(),
    );
    const runtimeId = "repro8-runtime";
    await registerRuntimeFixture(projectId, runtimeId);

    // The authenticated daemon, through the verified Worker -> Durable Object boundary.
    const daemonResponse = await env.RUNTIME_RELAY.getByName(runtimeId).fetch(
        `https://runtime.internal/projects/${projectId}/daemon`,
        {
            headers: {
                Upgrade: "websocket",
                "x-morty-channel-id": runtimeId,
                "x-morty-runtime-id": runtimeId,
            },
        },
    );
    expect(daemonResponse.status).toBe(101);
    const daemon = daemonResponse.webSocket;
    if (daemon === null) {
        throw new Error("Expected a daemon connection");
    }
    const daemonInbox = new Inbox(daemon);
    daemon.accept();
    expect(await daemonInbox.next()).toEqual({ kind: "runtime.liveness.ready" });

    // A credential in the URL is refused: URLs reach logs and traces that request headers do not.
    const inUrl = await worker.fetch(
        new Request(
            `${origin}/v1/projects/${projectId}/runtimes/${runtimeId}/host?token=${defaultCredential.credential}`,
            { headers: { Upgrade: "websocket" } },
        ),
        env,
    );
    expect(inUrl.status).toBe(401);

    // The App's host, through the public route with its AppCredential.
    const opened = await worker.fetch(
        new Request(`${origin}/v1/projects/${projectId}/runtimes/${runtimeId}/host`, {
            headers: { authorization: `Bearer ${defaultCredential.credential}`, Upgrade: "websocket" },
        }),
        env,
    );
    expect(opened.status).toBe(101);
    const host = opened.webSocket;
    if (host === null) {
        throw new Error("Expected a host connection");
    }
    const hostInbox = new Inbox(host);
    host.accept();
    expect(await hostInbox.next()).toMatchObject({ kind: "runtime.status", online: true });

    await revokeMortyCredential(env.PLATFORM_DIRECTORY_DATABASE, defaultCredential.credentialId);

    // The same credential is refused on HTTP right away.
    const http = await worker.fetch(
        new Request(`${origin}/v1/projects/${projectId}/runtimes`, {
            headers: { authorization: `Bearer ${defaultCredential.credential}` },
        }),
        env,
    );
    expect(http.status).toBe(401);

    // The host sends nothing, yet the Relay's scheduled connection check ends its access.
    expect(await runDurableObjectAlarm(env.RUNTIME_RELAY.getByName(runtimeId))).toBe(true);
    expect(await hostInbox.closed.promise).toEqual({ code: 1008, reason: "Channel access revoked" });
    daemon.close(1000, "done");
});
