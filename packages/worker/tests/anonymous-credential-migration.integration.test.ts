import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import initial from "../migrations/project-do/0001_initial.sql?raw";
import anonymousIdentity from "../migrations/project-do/0002_anonymous_identity.sql?raw";
import remoteAccess from "../migrations/project-do/0008_remote_access.sql?raw";
import credentialBrowser from "../migrations/project-do/0032_lively_arachne.sql?raw";
import anonymousCredentialRevocation from "../migrations/project-do/0034_anonymous_credential_revocation.sql?raw";

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
