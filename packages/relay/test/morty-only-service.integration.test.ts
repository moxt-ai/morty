import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { describe, expect, it } from "vitest";
import { revokeMortyCredential, seedMortyService } from "../../platform-test-support/src/service-fixture.ts";
import worker from "../src/worker.ts";

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
            new Request(`https://relay.test${MORTY_API_PREFIX}/dashboard/v1/apps/morty/projects`, {
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
    const request = (appId: string, credential: string) =>
        new Request(`https://relay.test${MORTY_API_PREFIX}/dashboard/v1/apps/${appId}/projects`, {
            method: "POST",
            headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
            body: JSON.stringify({
                displayName: "Isolated project",
                idempotencyKey: "isolated-project",
                locationHint: "wnam",
            }),
        });
    const benchmarkBindings = { ...env, PLATFORM_DIRECTORY_DATABASE: env.TEST_UNINITIALIZED_SHARD };
    expect((await worker.fetch(request(production.appId, production.credential), benchmarkBindings)).status).toBe(401);
    expect((await worker.fetch(request(benchmark.appId, benchmark.credential), env)).status).toBe(401);
    const accepted = await worker.fetch(request(production.appId, production.credential), env);
    expect(accepted.status).toBe(201);
    const project = await accepted.json();
    const retried = await worker.fetch(request(production.appId, production.credential), env);
    expect(retried.status).toBe(201);
    expect(await retried.json()).toEqual(project);
    await revokeMortyCredential(env.PLATFORM_DIRECTORY_DATABASE, production.credentialId);
    expect((await worker.fetch(request(production.appId, production.credential), env)).status).toBe(401);
    expect((await worker.fetch(request(benchmark.appId, benchmark.credential), benchmarkBindings)).status).toBe(201);
});
