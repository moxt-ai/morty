import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import initial from "../migrations/project-do/0001_initial.sql?raw";
import anonymousIdentity from "../migrations/project-do/0002_anonymous_identity.sql?raw";
import remoteAccess from "../migrations/project-do/0008_remote_access.sql?raw";
import credentialBrowser from "../migrations/project-do/0032_lively_arachne.sql?raw";
import anonymousCredentialRevocation from "../migrations/project-do/0034_anonymous_credential_revocation.sql?raw";
import anonymousCredentialKind from "../migrations/project-do/0035_anonymous_credential_kind.sql?raw";

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
