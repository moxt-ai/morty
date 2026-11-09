import { DatabaseSync } from "node:sqlite";
import { createResponseLossProxy } from "@morty-build/platform-test-support/response-loss-proxy";
import * as v from "valibot";
import { expect, test } from "vitest";
import legacyMapping from "../migrations/project-do/0003_platform_project.sql?raw";
import platformComputerIdentity from "../migrations/project-do/0033_platform_project_identity.sql?raw";
import ownerKeyedMapping from "../migrations/project-do/0051_key_project_mapping_by_owner.sql?raw";
import worker from "../src/application.ts";
import { APP_ORIGIN, accountRequest, createIdentityFixture } from "./support/identity-fixture.ts";

test("Given a Project mapping saved under an old origin and service setting, When its schema is migrated, Then its owner's Project and its saved facts are preserved", () => {
    using database = new DatabaseSync(":memory:");
    database.exec(legacyMapping);
    database
        .prepare(
            "INSERT INTO platform_project_mapping (user_id, platform_origin, app_id, project_id, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
            "usr_existing",
            "https://old-platform.example.test",
            "app_morty",
            "prj_existing",
            "Existing Project",
            1793059200000,
        );

    for (const migration of [platformComputerIdentity, ownerKeyedMapping]) {
        database.exec("BEGIN");
        database.exec(migration);
        database.exec("COMMIT");
    }

    // The deployment setting no longer names the mapping; its owner alone does.
    expect(database.prepare("SELECT * FROM platform_project_mapping WHERE user_id = ?").get("usr_existing")).toEqual({
        user_id: "usr_existing",
        project_id: "prj_existing",
        display_name: "Existing Project",
        created_at: 1793059200000,
    });
});

test("Given a machine owner and a deployment service credential, When the owner opens management, Then they can pair a Runtime for their account", async () => {
    const fixture = await createIdentityFixture();
    try {
        const identity = await fixture.createAnonymousUser();
        const projectUrl = `${APP_ORIGIN}/morty/api/computers/${identity.computerId}/management`;
        const headers = { authorization: `Bearer ${identity.token}` };

        const environment = fixture.environment();

        const project = await worker.fetch(new Request(`${projectUrl}/computer`, { headers }), environment);
        expect(project.status).toBe(200);
        expect(await project.json()).toMatchObject({ computer: { computerId: identity.computerId } });
        const pairing = await worker.fetch(
            new Request(`${projectUrl}/pairings`, {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify({ idempotencyKey: "reconfigured-service-pairing" }),
            }),
            environment,
        );
        expect(pairing.status).toBe(201);
        expect(await pairing.json()).toMatchObject({ computerId: identity.computerId });
    } finally {
        await fixture.close();
    }
});

test("Given an existing Project and Machine, When the same Platform moves to another origin, Then the user keeps their Project and can pair and replace it", {
    // This scenario builds and starts both real Workers, then reloads Chat at the new origin.
    timeout: 30_000,
}, async () => {
    const fixture = await createIdentityFixture();
    try {
        const identity = await fixture.createAnonymousUser();
        const projectUrl = `${APP_ORIGIN}/morty/api/computers/${identity.computerId}/management`;
        const headers = { authorization: `Bearer ${identity.token}` };
        const originalProject = await worker.fetch(
            new Request(`${projectUrl}/computer`, { headers }),
            fixture.environment(),
        );
        expect(originalProject.status).toBe(200);
        const project = await originalProject.json();
        const originalBot = await worker.fetch(new Request(`${projectUrl}/bot`, { headers }), fixture.environment());
        expect(originalBot.status).toBe(200);
        const bot = await originalBot.json();

        // A second listener forwards to the same real Platform and its existing storage.
        const relocated = await createResponseLossProxy(fixture.baseConfiguration.MORTY_RELAY_URL);
        try {
            await fixture.changePlatformOrigin(relocated.origin);
            const environment = fixture.environment();
            const session = await worker.fetch(accountRequest(identity.token, identity.computerId), environment);
            expect(session.status).toBe(200);
            expect(await session.json()).toMatchObject({ userId: identity.userId });
            const currentBot = await worker.fetch(new Request(`${projectUrl}/bot`, { headers }), environment);
            expect(currentBot.status).toBe(200);
            expect(await currentBot.json()).toEqual(bot);
            const currentProject = await worker.fetch(new Request(`${projectUrl}/computer`, { headers }), environment);
            expect(currentProject.status).toBe(200);
            expect(await currentProject.json()).toEqual(project);

            const pairing = await worker.fetch(
                new Request(`${projectUrl}/pairings`, {
                    method: "POST",
                    headers: { ...headers, "content-type": "application/json" },
                    body: JSON.stringify({ idempotencyKey: "relocated-platform-pairing" }),
                }),
                environment,
            );
            expect(pairing.status).toBe(201);
            expect(await pairing.json()).toMatchObject({ computerId: identity.computerId, relayUrl: relocated.origin });

            const replaced = await worker.fetch(
                new Request(`${projectUrl}/computer/replacement`, {
                    method: "POST",
                    headers,
                }),
                environment,
            );
            expect(replaced.status).toBe(201);
            const replacement = v.parse(
                v.object({ userId: v.string(), computerId: v.string(), token: v.string() }),
                await replaced.json(),
            );
            expect(replacement.userId).toBe(identity.userId);
            expect(replacement.computerId).not.toBe(identity.computerId);
            expect(
                (await worker.fetch(accountRequest(replacement.token, replacement.computerId), environment)).status,
            ).toBe(200);
        } finally {
            await relocated.close();
        }
    } finally {
        await fixture.close();
    }
});
