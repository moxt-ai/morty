import { and, eq } from "drizzle-orm";
import type {
    EffectiveRecordingMode,
    RecordingPolicyMode,
    ResolvedRecordingPolicy,
} from "../entity/recording-policy.ts";
import { platformApp, platformAppRecordingPolicy, platformProject } from "../schema/d1/index.ts";
import { type PlatformDrizzleDatabase, platformDrizzle } from "./platform-drizzle-database.ts";
import { appActive, projectServed } from "./platform-lifecycle.ts";

type StoredRecordingMode = EffectiveRecordingMode;

function resolved(mode: RecordingPolicyMode, appMode: StoredRecordingMode | null): ResolvedRecordingPolicy {
    if (appMode !== null) {
        return { effectiveMode: appMode, inheritedFrom: "app", mode };
    }
    return { effectiveMode: "disabled", inheritedFrom: "system", mode };
}

export class RecordingPolicyStorage {
    readonly #database: PlatformDrizzleDatabase;

    constructor(database: D1Database) {
        this.#database = platformDrizzle(database);
    }

    readonly readApp = async (appId: string, signal: AbortSignal): Promise<ResolvedRecordingPolicy | null> => {
        signal.throwIfAborted();
        const rows = await this.#database
            .select({ mode: platformAppRecordingPolicy.mode })
            .from(platformApp)
            .leftJoin(platformAppRecordingPolicy, eq(platformAppRecordingPolicy.appId, platformApp.appId))
            .where(and(eq(platformApp.appId, appId), appActive))
            .limit(1);
        signal.throwIfAborted();
        const row = rows[0];
        return row === undefined ? null : resolved(row.mode ?? "inherit", row.mode);
    };

    readonly readProject = async (projectId: string, signal: AbortSignal): Promise<ResolvedRecordingPolicy | null> => {
        signal.throwIfAborted();
        const rows = await this.#database
            .select({ appMode: platformAppRecordingPolicy.mode })
            .from(platformProject)
            .leftJoin(platformAppRecordingPolicy, eq(platformAppRecordingPolicy.appId, platformProject.appId))
            .where(and(eq(platformProject.projectId, projectId), projectServed))
            .limit(1);
        signal.throwIfAborted();
        const row = rows[0];
        return row === undefined ? null : resolved("inherit", row.appMode);
    };
}
