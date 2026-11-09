import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    revokeMortyCredential,
    seedMortyCredential,
    seedMortyService,
} from "../../platform-test-support/src/service-fixture.ts";
import { machineAccountGrant } from "../src/schema/d1/index.ts";
import worker from "../src/worker.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T00:00:00Z") }));
afterEach(() => vi.useRealTimers());

it("Given a scoped service credential, When its authoritative grant is removed, Then access is denied until explicitly granted again", async () => {
    const service = await seedMortyService(env.PLATFORM_DIRECTORY_DATABASE);
    const created = await worker.fetch(
        new Request(`https://relay.test${MORTY_API_PREFIX}/dashboard/v1/machine-accounts`, {
            method: "POST",
            headers: { authorization: `Bearer ${service.credential}`, "content-type": "application/json" },
            body: JSON.stringify({ displayName: "Scoped", idempotencyKey: "scoped-project", locationHint: "wnam" }),
        }),
        env,
    );
    expect(created.status).toBe(201);
    const project: unknown = await created.json();
    if (
        typeof project !== "object" ||
        project === null ||
        !("projectId" in project) ||
        typeof project.projectId !== "string"
    ) {
        throw new Error("Expected a created Project");
    }
    const { projectId } = project;
    const scoped = await seedMortyCredential(
        env.PLATFORM_DIRECTORY_DATABASE,
        service.appId,
        ["runtime:read"],
        [projectId],
    );
    const read = () =>
        worker.fetch(
            new Request(`https://relay.test${MORTY_API_PREFIX}/v1/projects/${projectId}/runtimes`, {
                headers: { authorization: `Bearer ${scoped.credential}` },
            }),
            env,
        );
    expect((await read()).status).toBe(200);
    const db = drizzle(env.PLATFORM_DIRECTORY_DATABASE);
    await db.delete(machineAccountGrant).where(eq(machineAccountGrant.credentialId, scoped.credentialId));
    expect((await read()).status).toBe(403);
    await db
        .insert(machineAccountGrant)
        .values({ credentialId: scoped.credentialId, projectId, createdAt: Date.now() });
    expect((await read()).status).toBe(200);
});

describe("Morty-only relay", () => {
    it("Given Morty service bindings, When a visitor requests the retired platform API, Then no management surface exists", async () => {
        for (const path of ["/capabilities", "/v1/platform/tenants", "/v1/apps"]) {
            const response = await worker.fetch(
                new Request(`https://relay.test${MORTY_API_PREFIX}/dashboard${path}`),
                env,
            );
            expect(response.status).toBe(404);
        }
    });

    it("Given no service credential, When a caller provisions a project, Then removing Clerk does not grant access", async () => {
        const response = await worker.fetch(
            new Request(`https://relay.test${MORTY_API_PREFIX}/dashboard/v1/machine-accounts`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    displayName: "Private",
                    idempotencyKey: "private-project",
                    locationHint: "wnam",
                }),
            }),
            env,
        );
        expect(response.status).toBe(401);
    });
});

it("Given separate production and benchmark service identities, When either credential is sent to the other environment, Then authorization fails and the owning environment remains usable", async () => {
    await applyD1Migrations(env.TEST_UNINITIALIZED_SHARD, env.TEST_PLATFORM_MIGRATIONS);
    const production = await seedMortyService(env.PLATFORM_DIRECTORY_DATABASE);
    const benchmark = await seedMortyService(env.TEST_UNINITIALIZED_SHARD);
    const request = (credential: string) =>
        new Request(`https://relay.test${MORTY_API_PREFIX}/dashboard/v1/machine-accounts`, {
            method: "POST",
            headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
            body: JSON.stringify({
                displayName: "Isolated project",
                idempotencyKey: "isolated-project",
                locationHint: "wnam",
            }),
        });
    const benchmarkBindings = { ...env, PLATFORM_DIRECTORY_DATABASE: env.TEST_UNINITIALIZED_SHARD };
    expect((await worker.fetch(request(production.credential), benchmarkBindings)).status).toBe(401);
    expect((await worker.fetch(request(benchmark.credential), env)).status).toBe(401);
    const accepted = await worker.fetch(request(production.credential), env);
    expect(accepted.status).toBe(201);
    const project = await accepted.json();
    const retried = await worker.fetch(request(production.credential), env);
    expect(retried.status).toBe(201);
    expect(await retried.json()).toEqual(project);
    await revokeMortyCredential(env.PLATFORM_DIRECTORY_DATABASE, production.credentialId);
    expect((await worker.fetch(request(production.credential), env)).status).toBe(401);
    expect((await worker.fetch(request(benchmark.credential), benchmarkBindings)).status).toBe(201);
});

it("Given the launch relay, When a visitor uses its Morty health endpoint or the retired product prefix, Then only the Morty endpoint is available", async () => {
    const health = await worker.fetch(new Request("https://relay.test/morty/api/dashboard/health"), env);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ service: "morty-relay", status: "ok" });
    const retired = await worker.fetch(new Request("https://relay.test/mobius/api/dashboard/health"), env);
    expect(retired.status).toBe(404);
});
