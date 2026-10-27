import management from "../../migrations/project-do/0001_initial.sql?raw";
import anonymousIdentity from "../../migrations/project-do/0002_anonymous_identity.sql?raw";
import platformProject from "../../migrations/project-do/0003_platform_project.sql?raw";
import platformOrigin from "../../migrations/project-do/0004_platform_origin.sql?raw";
import agentPairing from "../../migrations/project-do/0005_agent_pairing.sql?raw";
import managedSession from "../../migrations/project-do/0006_chat_managed_session.sql?raw";
import transferRedemptions from "../../migrations/project-do/0007_identity_transfer_redemptions.sql?raw";
import remoteAccess from "../../migrations/project-do/0008_remote_access.sql?raw";
import managedSessionImport from "../../migrations/project-do/0009_chat_managed_import.sql?raw";
import chatOwnedBot from "../../migrations/project-do/0010_chat_owned_bot.sql?raw";
import migration0011 from "../../migrations/project-do/0011_slack_chat_bot_binding.sql?raw";
import removeLegacyBotMigration from "../../migrations/project-do/0012_remove_legacy_bot_migration.sql?raw";
import pairingExpectedRuntime from "../../migrations/project-do/0013_volatile_colossus.sql?raw";
import managedSessionArchive from "../../migrations/project-do/0014_bouncy_may_parker.sql?raw";
import removeLegacyManagedBotColumns from "../../migrations/project-do/0015_red_forge.sql?raw";
import migration0016 from "../../migrations/project-do/0016_damp_fat_cobra.sql?raw";
import migration0017 from "../../migrations/project-do/0017_smooth_abomination.sql?raw";
import replaceManagedSessionMetadata from "../../migrations/project-do/0018_bumpy_ares.sql?raw";
import addManagedBotAgentRef from "../../migrations/project-do/0019_grey_clea.sql?raw";
import addLocalSessionDirectories from "../../migrations/project-do/0020_minor_vision.sql?raw";
import migration0021 from "../../migrations/project-do/0021_black_hairball.sql?raw";
import migration0022 from "../../migrations/project-do/0022_eminent_wiccan.sql?raw";
import removeManagedSessionArchive from "../../migrations/project-do/0023_smiling_zaladane.sql?raw";
import removeLocalSessionMetadata from "../../migrations/project-do/0024_fair_blizzard.sql?raw";
import removeIntegrationTables from "../../migrations/project-do/0025_misty_scarlet_witch.sql?raw";
import removeManagedBotAgentRef from "../../migrations/project-do/0026_slimy_ink.sql?raw";
import removeIdentityTransferExpiry from "../../migrations/project-do/0027_dazzling_grim_reaper.sql?raw";
import restoreContinueLinkExpiry from "../../migrations/project-do/0028_lovely_harpoon.sql?raw";
import removeContinueLinkUsageLimit from "../../migrations/project-do/0029_late_hammerhead.sql?raw";

import deferredAgentPairing from "../../migrations/project-do/0030_tough_speedball.sql?raw";
import removeClerkUserBinding from "../../migrations/project-do/0031_wealthy_silver_centurion.sql?raw";
import credentialBrowser from "../../migrations/project-do/0032_lively_arachne.sql?raw";
import platformProjectIdentity from "../../migrations/project-do/0033_platform_project_identity.sql?raw";
import anonymousCredentialRevocation from "../../migrations/project-do/0034_anonymous_credential_revocation.sql?raw";

/** Generated Project Durable Object migrations, in order. The ledger records each by its tag. */
const migrations = [
    { tag: "0001_initial", sql: management },
    { tag: "0002_anonymous_identity", sql: anonymousIdentity },
    { tag: "0003_platform_project", sql: platformProject },
    { tag: "0004_platform_origin", sql: platformOrigin },
    { tag: "0005_agent_pairing", sql: agentPairing },
    { tag: "0006_chat_managed_session", sql: managedSession },
    { tag: "0007_identity_transfer_redemptions", sql: transferRedemptions },
    { tag: "0008_remote_access", sql: remoteAccess },
    { tag: "0009_chat_managed_import", sql: managedSessionImport },
    { tag: "0010_chat_owned_bot", sql: chatOwnedBot },
    { tag: "0011_slack_chat_bot_binding", sql: migration0011 },
    { tag: "0012_remove_legacy_bot_migration", sql: removeLegacyBotMigration },
    { tag: "0013_volatile_colossus", sql: pairingExpectedRuntime },
    { tag: "0014_bouncy_may_parker", sql: managedSessionArchive },
    { tag: "0015_red_forge", sql: removeLegacyManagedBotColumns },
    { tag: "0016_damp_fat_cobra", sql: migration0016 },
    { tag: "0017_smooth_abomination", sql: migration0017 },
    { tag: "0018_bumpy_ares", sql: replaceManagedSessionMetadata },
    { tag: "0019_grey_clea", sql: addManagedBotAgentRef },
    { tag: "0020_minor_vision", sql: addLocalSessionDirectories },
    { tag: "0021_black_hairball", sql: migration0021 },
    { tag: "0022_eminent_wiccan", sql: migration0022 },
    { tag: "0023_smiling_zaladane", sql: removeManagedSessionArchive },
    { tag: "0024_fair_blizzard", sql: removeLocalSessionMetadata },
    { tag: "0025_misty_scarlet_witch", sql: removeIntegrationTables },
    { tag: "0026_slimy_ink", sql: removeManagedBotAgentRef },
    { tag: "0027_dazzling_grim_reaper", sql: removeIdentityTransferExpiry },
    { tag: "0028_lovely_harpoon", sql: restoreContinueLinkExpiry },
    { tag: "0029_late_hammerhead", sql: removeContinueLinkUsageLimit },
    { tag: "0030_tough_speedball", sql: deferredAgentPairing },
    { tag: "0031_wealthy_silver_centurion", sql: removeClerkUserBinding },
    { tag: "0032_lively_arachne", sql: credentialBrowser },
    { tag: "0033_platform_project_identity", sql: platformProjectIdentity },
    { tag: "0034_anonymous_credential_revocation", sql: anonymousCredentialRevocation },
];

/**
 * Earlier Workers recorded a migration's position in their list, which never included 0023. Those positions are
 * history: they say which migrations an existing ledger applied, and a rolled-back Worker still reads them.
 */
const positionLedger = migrations
    .map((migration) => migration.tag)
    .filter((tag) => tag !== "0023_smiling_zaladane")
    .slice(0, 33);

type BoundValue = ArrayBuffer | string | number | null;

function boundValue(value: unknown): BoundValue {
    if (value instanceof ArrayBuffer) {
        return value;
    }
    if (value === null || typeof value === "string" || typeof value === "number") {
        return value;
    }
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }
    throw new TypeError("Unsupported SQL binding.");
}

class DurableObjectStatement {
    readonly #query: string;
    readonly #sql: SqlStorage;
    readonly #values: readonly BoundValue[];

    constructor(sql: SqlStorage, query: string, values: readonly BoundValue[] = []) {
        this.#sql = sql;
        this.#query = query;
        this.#values = values;
    }

    readonly bind = (...values: readonly unknown[]) =>
        new DurableObjectStatement(this.#sql, this.#query, values.map(boundValue));

    readonly first = async (column?: string): Promise<unknown> => {
        const row = this.#sql.exec(this.#query, ...this.#values).toArray()[0] ?? null;
        return row !== null && column !== undefined ? (row[column] ?? null) : row;
    };

    readonly all = async () => ({ results: this.#sql.exec(this.#query, ...this.#values).toArray(), success: true });

    readonly raw = async () =>
        this.#sql
            .exec(this.#query, ...this.#values)
            .toArray()
            .map((row) => Object.values(row));

    readonly run = async () => this.runSynchronously();

    readonly runSynchronously = () => {
        const cursor = this.#sql.exec(this.#query, ...this.#values);
        cursor.toArray();
        const { changes } = this.#sql.exec<{ changes: number }>("SELECT changes() AS changes").one();
        return { meta: { changes }, success: true };
    };
}

export class DurableObjectDatabase {
    readonly #storage: DurableObjectStorage;

    constructor(storage: DurableObjectStorage) {
        this.#storage = storage;
        this.#migrate();
    }

    readonly prepare = (query: string) => new DurableObjectStatement(this.#storage.sql, query);

    readonly batch = async (statements: readonly DurableObjectStatement[]) =>
        this.#storage.transactionSync(() => statements.map((statement) => statement.runSynchronously()));

    readonly #migrate = () => {
        this.#storage.transactionSync(() => {
            this.#storage.sql.exec(
                "CREATE TABLE IF NOT EXISTS _chat_schema_migration (version INTEGER PRIMARY KEY NOT NULL)",
            );
            this.#storage.sql.exec(
                "CREATE TABLE IF NOT EXISTS _project_schema_migration (tag TEXT PRIMARY KEY NOT NULL)",
            );
            const positions = this.#storage.sql
                .exec<{ version: number }>("SELECT version FROM _chat_schema_migration")
                .toArray()
                .map((row) => positionLedger[row.version - 1]);
            for (const tag of positions) {
                if (tag !== undefined) {
                    this.#storage.sql.exec("INSERT OR IGNORE INTO _project_schema_migration (tag) VALUES (?)", tag);
                }
            }
            const applied = new Set(
                this.#storage.sql
                    .exec<{ tag: string }>("SELECT tag FROM _project_schema_migration")
                    .toArray()
                    .map((row) => row.tag),
            );
            for (const migration of migrations) {
                if (!applied.has(migration.tag)) {
                    this.#storage.sql.exec(migration.sql);
                    this.#storage.sql.exec("INSERT INTO _project_schema_migration (tag) VALUES (?)", migration.tag);
                    // A rolled-back Worker reads only positions; without them it would replay applied migrations.
                    const position = positionLedger.indexOf(migration.tag);
                    if (position >= 0) {
                        this.#storage.sql.exec("INSERT INTO _chat_schema_migration (version) VALUES (?)", position + 1);
                    }
                }
            }
        });
    };
}
