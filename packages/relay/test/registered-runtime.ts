import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { RELAY_APP_PROJECT_PERMISSIONS, type SessionAccessHolder } from "@morty-build/client/protocol";
import { eq } from "drizzle-orm";
import { relayDrizzle } from "../../relay-core/src/infra/drizzle-database.ts";
import { DurableObjectDatabaseAdapter } from "../../relay-core/src/infra/durable-object-sql-database.ts";
import { computer } from "../../relay-core/src/schema/project-do/index.ts";
import { IdentityStorage } from "../../worker/src/components/management/storage/identity-storage.ts";
import { ManagedBotStorage } from "../../worker/src/components/management/storage/managed-bot-storage.ts";
import { ComputerChat } from "../../worker/src/components/project/computer-chat.ts";
import { DurableObjectDatabase } from "../../worker/src/infra/durable-object-database.ts";
import { migrateComputerStorage } from "../src/durable-objects/migrate-computer-storage.ts";
import { machineAccount, serviceCredential } from "../src/schema/d1/index.ts";
import { computerDirectoryDrizzle } from "../src/storage/relay-drizzle-database.ts";
import { SqliteComputerManagementStore } from "../src/storage/sqlite-computer-management-store.ts";

/** The computer's store as its ComputerRelay composes it, answering whose access holds from the computer's identities. */
export function computerManagementStore(computerId: string, storage: DurableObjectStorage) {
    const chat = new ComputerChat(
        storage,
        (id) => id === computerId,
        async () => {},
    );
    return new SqliteComputerManagementStore(computerId, new DurableObjectDatabaseAdapter(storage), (holder, signal) =>
        chat.holdsAccess(computerId, holder, signal),
    );
}

/**
 * The computer's owner holding its local credential, stored as identity bootstrap stores it. Session credentials the
 * scenarios issue carry this access, so they stay valid until the scenario ends it with `endOwnerAccess`.
 */
export async function ownerAccessHolder(computerId: string): Promise<SessionAccessHolder> {
    return await runInDurableObject(env.COMPUTER_RELAY.getByName(computerId), async (_instance, state) => {
        const signal = AbortSignal.timeout(10_000);
        const database = new DurableObjectDatabase(state.storage);
        const userId = `user_${computerId}`;
        const token = `morty_anon_v1_${"o".repeat(43)}`;
        await new ManagedBotStorage(database).claimMachine(userId, { displayName: "My Machine" }, Date.now(), signal);
        const identities = new IdentityStorage(database, computerId);
        await identities.createAnonymous(userId, computerId, Date.now(), signal, token);
        const credential = await identities.findCredential(token, signal);
        if (credential === null) {
            throw new Error("Missing owner credential");
        }
        return { kind: "credential", credentialId: credential.credentialId };
    });
}

/** Revokes the owner's local credential in storage, as retiring it does, without closing any live connection. */
export async function endOwnerAccess(computerId: string, holder: SessionAccessHolder): Promise<void> {
    if (holder.kind !== "credential") {
        throw new Error("Expected the owner's credential");
    }
    await runInDurableObject(env.COMPUTER_RELAY.getByName(computerId), async (_instance, state) => {
        const revoked = await new IdentityStorage(
            new DurableObjectDatabase(state.storage),
            computerId,
        ).revokeCredential(
            { kind: "local", credentialId: holder.credentialId, userId: `user_${computerId}` },
            Date.now(),
            AbortSignal.timeout(10_000),
        );
        if (!revoked) {
            throw new Error("The owner's credential was not revoked");
        }
    });
}

/** Internal Runtime DO scenarios enter after public pairing has registered the Runtime in an active Project. */
export async function registerRuntimeFixture(computerId: string): Promise<{ readonly hostCredentialId: string }> {
    const registeredAt = Date.UTC(2026, 9, 27);
    const appId = `app_${computerId}`;
    const directory = computerDirectoryDrizzle(env.RELAY_DIRECTORY_DATABASE);
    await directory.batch([
        directory
            .insert(machineAccount)
            .values({
                computerId,
                appId,
                displayName: "Registered test Project",
                clientReference: computerId,
                idempotencyKey: computerId,
                lifecycle: "active",
                createdAt: registeredAt,
                updatedAt: registeredAt,
            })
            .onConflictDoNothing(),
    ]);
    await runInDurableObject(env.COMPUTER_RELAY.getByName(computerId), async (_instance, state) => {
        migrateComputerStorage(state.storage);
        const database = relayDrizzle(new DurableObjectDatabaseAdapter(state.storage), AbortSignal.timeout(10_000));
        await database.batch([
            database
                .insert(computer)
                .values({
                    computerId,
                    createdAt: registeredAt,
                    claimedAt: registeredAt,
                    machineName: "Registered test Runtime",
                    workspaceName: "Registered test workspace",
                    agentsJson: "[]",
                })
                .onConflictDoNothing(),
        ]);
    });
    const project = await directory
        .select({ appId: machineAccount.appId })
        .from(machineAccount)
        .where(eq(machineAccount.computerId, computerId))
        .get();
    if (project === undefined) {
        throw new Error("Missing fixture project");
    }
    const hostCredentialId = `fixture_${crypto.randomUUID()}`;
    await directory.insert(serviceCredential).values({
        credentialId: hostCredentialId,
        publicCredentialId: crypto.randomUUID(),
        appId: project.appId,
        secretDigest: "internal-verified-host-fixture",
        permissionsJson: JSON.stringify(RELAY_APP_PROJECT_PERMISSIONS),
        allProjects: 1,
        issuedAt: registeredAt,
    });
    return { hostCredentialId };
}
