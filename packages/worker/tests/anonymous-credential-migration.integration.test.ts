import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import initial from "../migrations/project-do/0001_initial.sql?raw";
import anonymousIdentity from "../migrations/project-do/0002_anonymous_identity.sql?raw";
import remoteAccess from "../migrations/project-do/0008_remote_access.sql?raw";
import credentialBrowser from "../migrations/project-do/0032_lively_arachne.sql?raw";
import anonymousCredentialRevocation from "../migrations/project-do/0034_anonymous_credential_revocation.sql?raw";
import anonymousCredentialKind from "../migrations/project-do/0035_anonymous_credential_kind.sql?raw";
import { projectDurableObjectMigrations as migrations } from "../src/generated/project-do-migrations.ts";

test("Given saved active and revoked credentials, When their schema is migrated, Then credential facts and revocation times are preserved", () => {
    using database = new DatabaseSync(":memory:");
    for (const migration of [initial, anonymousIdentity, remoteAccess, credentialBrowser]) {
        database.exec(migration);
    }
    const credentials = [
        {
            id: "cred_active",
            user_id: "usr_existing",
            token_hash: "active-token-hash",
            created_at: 1793059200000,
            revoked_at: null,
            remote_transfer_id: null,
            browser_id: null,
        },
        {
            id: "cred_revoked",
            user_id: "usr_existing",
            token_hash: "revoked-token-hash",
            created_at: 1793059200000,
            revoked_at: 1793062800000,
            remote_transfer_id: "transfer_existing",
            browser_id: "cred_browser",
        },
    ];
    const insert = database.prepare(
        "INSERT INTO anonymous_credential (id, user_id, token_hash, status, created_at, revoked_at, remote_transfer_id, browser_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const credential of credentials) {
        insert.run(
            credential.id,
            credential.user_id,
            credential.token_hash,
            credential.revoked_at === null ? "active" : "revoked",
            credential.created_at,
            credential.revoked_at,
            credential.remote_transfer_id,
            credential.browser_id,
        );
    }

    database.exec("BEGIN");
    database.exec(anonymousCredentialRevocation);
    database.exec("COMMIT");

    expect(
        database
            .prepare(
                "SELECT id, user_id, token_hash, created_at, revoked_at, remote_transfer_id, browser_id FROM anonymous_credential ORDER BY id",
            )
            .all(),
    ).toEqual(credentials);
    expect(database.prepare("SELECT id FROM anonymous_credential WHERE revoked_at IS NULL").all()).toEqual([
        { id: "cred_active" },
    ]);
});

test("Given an untyped credential database, When credential kinds are added, Then existing facts remain unknown and a rolled-back Worker can still issue, read and revoke credentials", () => {
    using database = new DatabaseSync(":memory:");
    for (const migration of [
        initial,
        anonymousIdentity,
        remoteAccess,
        credentialBrowser,
        anonymousCredentialRevocation,
    ]) {
        database.exec(migration);
    }
    // The insert and reads are the persisted contract at 53692134, before kind existed.
    const issue = database.prepare(
        "INSERT INTO anonymous_credential (id, user_id, token_hash, created_at) VALUES (?, ?, ?, ?)",
    );
    issue.run("before", "usr_existing", "hash-before", 1793059200000);
    database.exec(anonymousCredentialKind);
    issue.run("rollback", "usr_existing", "hash-rollback", 1793059200000);
    expect(database.prepare("SELECT id, kind FROM anonymous_credential ORDER BY id").all()).toEqual([
        { id: "before", kind: null },
        { id: "rollback", kind: null },
    ]);
    database
        .prepare("UPDATE anonymous_credential SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
        .run(1793062800000, "hash-before");
    expect(database.prepare("SELECT id FROM anonymous_credential WHERE revoked_at IS NULL").all()).toEqual([
        { id: "rollback" },
    ]);
});

test("Given browsers that joined before devices had their own record, When the schema is migrated, Then each browser becomes one device described by its first joining and keeps its credentials", () => {
    using database = new DatabaseSync(":memory:");
    const position = migrations.findIndex((migration) => migration.name === "0042_browser_devices.sql");
    for (const migration of migrations.slice(0, position)) {
        database.exec(migration.sql);
    }
    const link = database.prepare(
        "INSERT INTO identity_transfer (id, code_hash, user_id, expires_at, access_expires_at, redeemed_at, created_at, created_by_credential_id) VALUES (?, ?, 'usr_owner', 2, 3, ?, 1, 'cred_local')",
    );
    link.run("transfer_legacy", "legacy-code", 1);
    link.run("transfer_first", "first-code", 1);
    link.run("transfer_again", "again-code", 2);
    link.run("transfer_unused", "unused-code", null);
    const credential = database.prepare(
        "INSERT INTO anonymous_credential (id, user_id, token_hash, kind, created_at, revoked_at, remote_transfer_id, browser_id, device_label) VALUES (?, 'usr_owner', ?, ?, ?, ?, ?, ?, ?)",
    );
    credential.run("cred_local", "local-hash", "local", 0, null, null, null, null);
    // Saved before credentials had a kind, and before browsers described themselves.
    credential.run("cred_legacy", "legacy-hash", null, 1, null, "transfer_legacy", null, null);
    // A browser that joined, then opened another link: its first credential names it.
    credential.run("cred_first", "first-hash", "browser", 1, 2, "transfer_first", null, "iPhone · Safari");
    credential.run("cred_again", "again-hash", "browser", 2, null, "transfer_again", "cred_first", "iPhone · Safari");

    for (const migration of migrations.slice(position)) {
        database.exec(migration.sql);
    }

    expect(database.prepare("SELECT * FROM browser_device ORDER BY id").all()).toEqual([
        {
            id: "cred_first",
            user_id: "usr_owner",
            joined_at: 1,
            label: "iPhone · Safari",
            joined_city: null,
            joined_country: null,
            joined_through_transfer_id: "transfer_first",
        },
        {
            id: "cred_legacy",
            user_id: "usr_owner",
            joined_at: 1,
            label: null,
            joined_city: null,
            joined_country: null,
            joined_through_transfer_id: "transfer_legacy",
        },
    ]);
    expect(
        database
            .prepare("SELECT id, kind, revoked_at, remote_transfer_id, device_id FROM anonymous_credential ORDER BY id")
            .all(),
    ).toEqual([
        {
            id: "cred_again",
            kind: "browser",
            revoked_at: null,
            remote_transfer_id: "transfer_again",
            device_id: "cred_first",
        },
        {
            id: "cred_first",
            kind: "browser",
            revoked_at: 2,
            remote_transfer_id: "transfer_first",
            device_id: "cred_first",
        },
        {
            id: "cred_legacy",
            kind: "browser",
            revoked_at: null,
            remote_transfer_id: "transfer_legacy",
            device_id: "cred_legacy",
        },
        { id: "cred_local", kind: "local", revoked_at: null, remote_transfer_id: null, device_id: null },
    ]);
    expect(database.prepare("SELECT id, access_expires_at FROM identity_transfer ORDER BY id").all()).toHaveLength(4);
    expect(() =>
        database
            .prepare(
                "INSERT INTO anonymous_credential (id, user_id, token_hash, kind, created_at) VALUES ('cred_orphan', 'usr_owner', 'orphan-hash', 'browser', 3)",
            )
            .run(),
    ).toThrow();
});
