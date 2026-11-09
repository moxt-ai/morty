import type { D1Database } from "@cloudflare/workers-types";
import { PLATFORM_APP_PROJECT_PERMISSIONS } from "@morty-build/client/protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { machineAccount, machineAccountGrant, serviceCredential } from "../../relay/src/schema/d1/index.ts";
import { createRandomToken, hashSecret } from "../../relay-core/src/entity/pairing/pairing.ts";

/** Seed the deployment-owned service identity through storage, never through a retired management API. */
export async function seedMortyService(database: D1Database) {
    const db = drizzle(database);
    const appId = `app_${createRandomToken(18)}`;
    const credentialId = `credential_${createRandomToken(18)}`;
    const publicCredentialId = createRandomToken(16);
    const credential = `mapp_${publicCredentialId}_${createRandomToken(32)}`;
    const now = Date.now();
    const secretDigest = await hashSecret(credential);
    await db.insert(serviceCredential).values({
        credentialId,
        publicCredentialId,
        appId,
        secretDigest,
        permissionsJson: JSON.stringify(PLATFORM_APP_PROJECT_PERMISSIONS),
        allProjects: 1,
        issuedAt: now,
    });
    return { appId, credentialId, credential, defaultCredential: { credential, credentialId } };
}

export async function seedMortyCredential(
    database: D1Database,
    appId: string,
    permissions: readonly string[],
    computerIds: readonly string[] = [],
) {
    const db = drizzle(database);
    const credentialId = `credential_${createRandomToken(18)}`;
    const publicCredentialId = createRandomToken(16);
    const credential = `mapp_${publicCredentialId}_${createRandomToken(32)}`;
    await db.insert(serviceCredential).values({
        credentialId,
        publicCredentialId,
        appId,
        secretDigest: await hashSecret(credential),
        permissionsJson: JSON.stringify(permissions),
        allProjects: computerIds.length === 0 ? 1 : 0,
        issuedAt: Date.now(),
    });
    for (const computerId of computerIds) {
        await db.insert(machineAccountGrant).values({ credentialId, computerId, createdAt: Date.now() });
    }
    return { credentialId, credential };
}

export async function revokeMortyCredential(database: D1Database, credentialId: string) {
    await drizzle(database)
        .update(serviceCredential)
        .set({ revokedAt: Date.now() })
        .where(eq(serviceCredential.credentialId, credentialId));
}

export async function retireMortyService(database: D1Database, appId: string) {
    const db = drizzle(database);
    const now = Date.now();
    await db.batch([
        db
            .update(machineAccount)
            .set({ lifecycle: "deleted", deletedAt: now, updatedAt: now })
            .where(eq(machineAccount.appId, appId)),
        db.update(serviceCredential).set({ revokedAt: now }).where(eq(serviceCredential.appId, appId)),
    ]);
}
