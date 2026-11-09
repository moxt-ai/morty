import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { PLATFORM_APP_PROJECT_PERMISSIONS } from "@morty-build/client/protocol";
import { eq } from "drizzle-orm";
import { relayDrizzle } from "../../relay-core/src/infra/drizzle-database.ts";
import { DurableObjectDatabaseAdapter } from "../../relay-core/src/infra/durable-object-sql-database.ts";
import { runtimeIdentity, runtimeRegistration } from "../../relay-core/src/schema/project-do/index.ts";
import { platformApp, platformAppCredential, platformProject } from "../src/schema/d1/index.ts";
import { platformDrizzle } from "../src/storage/platform-drizzle-database.ts";

/** Internal Runtime DO scenarios enter after public pairing has registered the Runtime in an active Project. */
export async function registerRuntimeFixture(
    projectId: string,
    runtimeId: string,
): Promise<{ readonly hostCredentialId: string }> {
    const registeredAt = Date.UTC(2026, 9, 27);
    const appId = `app_${projectId}`;
    const directory = platformDrizzle(env.PLATFORM_DIRECTORY_DATABASE);
    await directory.batch([
        directory
            .insert(platformApp)
            .values({
                appId,
                tenantId: `tenant_${projectId}`,
                displayName: "Registered test App",
                lifecycle: "active",
                createdAt: registeredAt,
                updatedAt: registeredAt,
            })
            .onConflictDoNothing(),
        directory
            .insert(platformProject)
            .values({
                projectId,
                appId,
                displayName: "Registered test Project",
                clientReference: projectId,
                idempotencyKey: projectId,
                requestDigest: projectId,
                lifecycle: "active",
                createdAt: registeredAt,
                updatedAt: registeredAt,
            })
            .onConflictDoNothing(),
    ]);
    await runInDurableObject(env.PROJECT_RELAY.getByName(projectId), async (_instance, state) => {
        const database = relayDrizzle(new DurableObjectDatabaseAdapter(state.storage), AbortSignal.timeout(10_000));
        await database.batch([
            database
                .insert(runtimeIdentity)
                .values({ runtimeId, projectId, channelId: runtimeId, createdAt: registeredAt })
                .onConflictDoNothing(),
            database
                .insert(runtimeRegistration)
                .values({
                    runtimeId,
                    claimedAt: registeredAt,
                    machineName: "Registered test Runtime",
                    workspaceName: "Registered test workspace",
                    agentsJson: "[]",
                })
                .onConflictDoNothing(),
        ]);
    });
    const project = await directory
        .select({ appId: platformProject.appId })
        .from(platformProject)
        .where(eq(platformProject.projectId, projectId))
        .get();
    if (project === undefined) {
        throw new Error("Missing fixture project");
    }
    const hostCredentialId = `fixture_${crypto.randomUUID()}`;
    await directory.insert(platformAppCredential).values({
        credentialId: hostCredentialId,
        publicCredentialId: crypto.randomUUID(),
        appId: project.appId,
        secretDigest: "internal-verified-host-fixture",
        permissionsJson: JSON.stringify(PLATFORM_APP_PROJECT_PERMISSIONS),
        allProjects: 1,
        issuedAt: registeredAt,
    });
    return { hostCredentialId };
}
