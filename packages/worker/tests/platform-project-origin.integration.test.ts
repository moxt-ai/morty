import { DatabaseSync } from "node:sqlite";
import { createResponseLossProxy } from "@moxt-ai/mobius-test/response-loss-proxy";
import * as v from "valibot";
import { expect, test } from "vitest";
import legacyMapping from "../migrations/project-do/0003_platform_project.sql?raw";
import platformProjectIdentity from "../migrations/project-do/0033_platform_project_identity.sql?raw";
import worker from "../src/application.ts";
import { APP_ORIGIN, accountRequest, createIdentityFixture } from "./support/identity-fixture.ts";

test("Given a Project mapping saved under an old origin, When its schema is migrated, Then the user's Project and its saved facts are preserved", () => {
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

    database.exec("BEGIN");
    database.exec(platformProjectIdentity);
    database.exec("COMMIT");

    expect(
        database
            .prepare(
                "SELECT user_id, app_id, project_id, display_name, created_at FROM platform_project_mapping WHERE user_id = ? AND app_id = ?",
            )
            .get("usr_existing", "app_morty"),
    ).toEqual({
        user_id: "usr_existing",
        app_id: "app_morty",
        project_id: "prj_existing",
        display_name: "Existing Project",
        created_at: 1793059200000,
    });
});

test("Given an existing Project and Machine, When the same Platform moves to another origin, Then the user keeps their Project and can pair and replace it", {
    // This scenario builds and starts both real Workers, then reloads Chat at the new origin.
    timeout: 30_000,
}, async () => {
    const fixture = await createIdentityFixture();
    try {
        const identity = await fixture.createAnonymousUser();
        const projectUrl = `${APP_ORIGIN}/morty/api/projects/${identity.projectId}/management`;
        const headers = { authorization: `Bearer ${identity.token}` };
        const originalProject = await worker.fetch(
            new Request(`${projectUrl}/project`, { headers }),
            fixture.environment(),
        );
        expect(originalProject.status).toBe(200);
        const project = await originalProject.json();
        const originalBots = await worker.fetch(new Request(`${projectUrl}/bots`, { headers }), fixture.environment());
        expect(originalBots.status).toBe(200);
        const bots = await originalBots.json();

        // A second listener forwards to the same real Platform and its existing storage.
        const relocated = await createResponseLossProxy(fixture.baseConfiguration.MOBIUS_BASE_URL);
        try {
            await fixture.changePlatformOrigin(relocated.origin);
            const environment = fixture.environment();
            const session = await worker.fetch(accountRequest(identity.token, identity.projectId), environment);
            expect(session.status).toBe(200);
            expect(await session.json()).toMatchObject({ userId: identity.userId });
            const currentBots = await worker.fetch(new Request(`${projectUrl}/bots`, { headers }), environment);
            expect(currentBots.status).toBe(200);
            expect(await currentBots.json()).toEqual(bots);
            const currentProject = await worker.fetch(new Request(`${projectUrl}/project`, { headers }), environment);
            expect(currentProject.status).toBe(200);
            expect(await currentProject.json()).toEqual(project);

            const pairing = await worker.fetch(
                new Request(`${projectUrl}/runtime-pairings`, {
                    method: "POST",
                    headers: { ...headers, "content-type": "application/json" },
                    body: JSON.stringify({ idempotencyKey: "relocated-platform-pairing" }),
                }),
                environment,
            );
            expect(pairing.status).toBe(201);
            expect(await pairing.json()).toMatchObject({ projectId: identity.projectId, relayUrl: relocated.origin });

            const replaced = await worker.fetch(
                new Request(`${projectUrl}/project/replacement`, {
                    method: "POST",
                    headers,
                }),
                environment,
            );
            expect(replaced.status).toBe(201);
            const replacement = v.parse(
                v.object({ userId: v.string(), projectId: v.string(), token: v.string() }),
                await replaced.json(),
            );
            expect(replacement.userId).toBe(identity.userId);
            expect(replacement.projectId).not.toBe(identity.projectId);
            expect(
                (await worker.fetch(accountRequest(replacement.token, replacement.projectId), environment)).status,
            ).toBe(200);
        } finally {
            await relocated.close();
        }
    } finally {
        await fixture.close();
    }
});
