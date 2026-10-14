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
import removeLocalSessionMetadata from "../../migrations/project-do/0024_fair_blizzard.sql?raw";
import removeIntegrationTables from "../../migrations/project-do/0025_misty_scarlet_witch.sql?raw";
import removeManagedBotAgentRef from "../../migrations/project-do/0026_slimy_ink.sql?raw";
import removeIdentityTransferExpiry from "../../migrations/project-do/0027_dazzling_grim_reaper.sql?raw";
import restoreContinueLinkExpiry from "../../migrations/project-do/0028_lovely_harpoon.sql?raw";
import removeContinueLinkUsageLimit from "../../migrations/project-do/0029_late_hammerhead.sql?raw";

import deferredAgentPairing from "../../migrations/project-do/0030_tough_speedball.sql?raw";

const migrations = [
    management,
    anonymousIdentity,
    platformProject,
    platformOrigin,
    agentPairing,
    managedSession,
    transferRedemptions,
    remoteAccess,
    managedSessionImport,
    chatOwnedBot,
    migration0011,
    removeLegacyBotMigration,
    pairingExpectedRuntime,
    managedSessionArchive,
    removeLegacyManagedBotColumns,
    migration0016,
    migration0017,
    replaceManagedSessionMetadata,
    addManagedBotAgentRef,
    addLocalSessionDirectories,
    migration0021,
    migration0022,
    removeLocalSessionMetadata,
    removeIntegrationTables,
    removeManagedBotAgentRef,
    removeIdentityTransferExpiry,
    restoreContinueLinkExpiry,
    removeContinueLinkUsageLimit,
    deferredAgentPairing,
];

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
            const applied = new Set(
                this.#storage.sql
                    .exec<{ version: number }>("SELECT version FROM _chat_schema_migration")
                    .toArray()
                    .map((row) => row.version),
            );
            migrations.forEach((migration, index) => {
                const version = index + 1;
                if (!applied.has(version)) {
                    this.#storage.sql.exec(migration);
                    this.#storage.sql.exec("INSERT INTO _chat_schema_migration (version) VALUES (?)", version);
                }
            });
        });
    };
}
