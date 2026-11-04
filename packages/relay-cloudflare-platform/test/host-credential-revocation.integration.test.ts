import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-sdk/protocol";
import * as v from "valibot";
import { afterAll, beforeEach, expect, it } from "vitest";
import { createTestMobiusPlatformApp } from "../../test-support/src/app.ts";
import { FakeClerk } from "../../test-support/src/clerk.ts";
import { createPlatformGateways, PlatformAuthenticationConfiguration } from "../src/worker.ts";
import { registerRuntimeFixture } from "./registered-runtime.ts";

const origin = `https://platform.test${MOBIUS_API_PREFIX}`;
const clerk = new FakeClerk();

beforeEach(() => clerk.reset());
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
    const worker = createTestMobiusPlatformApp(
        new PlatformAuthenticationConfiguration(clerk.authenticator, new Set(["developer-1"])),
        createPlatformGateways,
        () => clerk.organizationGateway,
    );
    const headers = {
        authorization: `Bearer ${clerk.session("developer-1", clerk.defaultOrganizationId)}`,
        "content-type": "application/json",
        "x-mobius-oidc-provider": "clerk",
    };
    const dashboard = async (path: string, body?: object) =>
        await worker.fetch(
            new Request(`${origin}/dashboard/v1/${path}`, {
                headers,
                ...(body === undefined ? {} : { body: JSON.stringify(body), method: "POST" }),
            }),
            env,
        );
    const { tenants } = v.parse(
        v.object({ tenants: v.array(v.object({ tenantId: v.string() })) }),
        await (await dashboard("platform/tenants")).json(),
    );
    const { appId, defaultCredential } = v.parse(
        v.object({
            appId: v.string(),
            defaultCredential: v.object({ credential: v.string(), credentialId: v.string() }),
        }),
        await (await dashboard("apps", { displayName: "Repro8", tenantId: tenants[0]?.tenantId })).json(),
    );
    const { projectId } = v.parse(
        v.object({ projectId: v.string() }),
        await (
            await dashboard(`apps/${appId}/projects`, {
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
                "x-mobius-channel-id": runtimeId,
                "x-mobius-runtime-id": runtimeId,
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

    // The App's host, through the public route with its AppCredential.
    const opened = await worker.fetch(
        new Request(
            `${origin}/v1/projects/${projectId}/runtimes/${runtimeId}/host?token=${defaultCredential.credential}`,
            {
                headers: { Upgrade: "websocket" },
            },
        ),
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

    const revoked = await dashboard(`platform/app-credentials/${defaultCredential.credentialId}/revoke`, {});
    expect(revoked.status).toBe(200);

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
