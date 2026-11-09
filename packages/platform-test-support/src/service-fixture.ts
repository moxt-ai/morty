import type { D1Database } from "@cloudflare/workers-types";
import { PLATFORM_APP_PROJECT_PERMISSIONS } from "@morty-build/client/protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
    platformApp,
    platformAppCredential,
    platformAppCredentialScope,
    platformTenant,
} from "../../relay/src/schema/d1/index.ts";
import { createRandomToken, hashSecret } from "../../relay-core/src/entity/pairing/pairing.ts";

/** Seed the deployment-owned service identity through storage, never through a retired management API. */
export async function seedMortyService(database: D1Database) {
    const db = drizzle(database);
    const tenantId = `morty_${createRandomToken(12)}`;
    const appId = `app_${createRandomToken(18)}`;
    const credentialId = `credential_${createRandomToken(18)}`;
    const publicCredentialId = createRandomToken(16);
    const credential = `mapp_${publicCredentialId}_${createRandomToken(32)}`;
    const now = Date.now();
    const secretDigest = await hashSecret(credential);
    await db.batch([
        db.insert(platformTenant).values({
            tenantId,
            displayName: "Morty",
            quotasJson: JSON.stringify({ activeApps: 1, activeProjects: 1000 }),
            createdAt: now,
            updatedAt: now,
        }),
        db.insert(platformApp).values({
            appId,
            tenantId,
            displayName: "Morty",
            lifecycle: "active",
            initialCredentialId: credentialId,
            createdAt: now,
            updatedAt: now,
        }),
        db.insert(platformAppCredential).values({
            credentialId,
            publicCredentialId,
            appId,
            secretDigest,
            permissionsJson: JSON.stringify(PLATFORM_APP_PROJECT_PERMISSIONS),
            allProjects: 1,
            issuedAt: now,
        }),
    ]);
    return { tenantId, appId, credentialId, credential, defaultCredential: { credential, credentialId } };
}

export async function seedMortyCredential(
    database: D1Database,
    appId: string,
    permissions: readonly string[],
    projectIds: readonly string[] = [],
) {
    const db = drizzle(database);
    const credentialId = `credential_${createRandomToken(18)}`;
    const publicCredentialId = createRandomToken(16);
    const credential = `mapp_${publicCredentialId}_${createRandomToken(32)}`;
    await db.insert(platformAppCredential).values({
        credentialId,
        publicCredentialId,
        appId,
        secretDigest: await hashSecret(credential),
        permissionsJson: JSON.stringify(permissions),
        allProjects: projectIds.length === 0 ? 1 : 0,
        issuedAt: Date.now(),
    });
    for (const projectId of projectIds) {
        await db.insert(platformAppCredentialScope).values({ credentialId, projectId, createdAt: Date.now() });
    }
    return { credentialId, credential };
}

export async function revokeMortyCredential(database: D1Database, credentialId: string) {
    await drizzle(database)
        .update(platformAppCredential)
        .set({ revokedAt: Date.now() })
        .where(eq(platformAppCredential.credentialId, credentialId));
}

export async function retireMortyService(database: D1Database, appId: string) {
    const db = drizzle(database);
    const now = Date.now();
    await db.batch([
        db
            .update(platformApp)
            .set({ lifecycle: "deleted", deletedAt: now, updatedAt: now })
            .where(eq(platformApp.appId, appId)),
        db.update(platformAppCredential).set({ revokedAt: now }).where(eq(platformAppCredential.appId, appId)),
    ]);
}
