import type { AttachmentStorageResolver, DatabaseResolver } from "@moxt-ai/app-slack-api";
import { TenantStorageError } from "@moxt-ai/app-slack-api";
import * as v from "valibot";
import { D1SqlDatabase } from "../../apps/slack/packages/worker/src/storage/d1-database.ts";
import { R2SlackAttachmentStorage } from "../../apps/slack/packages/worker/src/storage/r2-slack-attachment-storage.ts";

export interface CloudSlackStorageBindings {
    readonly D1_SHARD_APAC_01?: unknown;
    readonly D1_SHARD_APAC_02?: unknown;
    readonly D1_SHARD_WNAM_01?: unknown;
    readonly D1_SHARD_WNAM_02?: unknown;
    readonly R2_BUCKET_APAC?: unknown;
    readonly R2_BUCKET_WNAM?: unknown;
}

const d1BindingSchema = v.object({
    batch: v.function(),
    prepare: v.function(),
});

function isD1Database(value: unknown): value is D1Database {
    return v.safeParse(d1BindingSchema, value).success;
}

const r2BindingSchema = v.object({
    get: v.function(),
    put: v.function(),
});

function isR2Bucket(value: unknown): value is R2Bucket {
    return v.safeParse(r2BindingSchema, value).success;
}

function configuredD1Binding(shardId: string, bindings: CloudSlackStorageBindings): D1Database | null {
    const value =
        shardId === "apac-01"
            ? bindings.D1_SHARD_APAC_01
            : shardId === "apac-02"
              ? bindings.D1_SHARD_APAC_02
              : shardId === "wnam-01"
                ? bindings.D1_SHARD_WNAM_01
                : shardId === "wnam-02"
                  ? bindings.D1_SHARD_WNAM_02
                  : undefined;
    return isD1Database(value) ? value : null;
}

export function configuredD1Candidates(
    bindings: CloudSlackStorageBindings,
): readonly { readonly database: D1Database; readonly shardId: string }[] {
    const candidates = [
        { database: bindings.D1_SHARD_APAC_01, shardId: "apac-01" },
        { database: bindings.D1_SHARD_APAC_02, shardId: "apac-02" },
        { database: bindings.D1_SHARD_WNAM_01, shardId: "wnam-01" },
        { database: bindings.D1_SHARD_WNAM_02, shardId: "wnam-02" },
    ];
    return candidates.flatMap((candidate) =>
        isD1Database(candidate.database) ? [{ database: candidate.database, shardId: candidate.shardId }] : [],
    );
}

function configuredR2Binding(bucketId: string, bindings: CloudSlackStorageBindings): R2Bucket | null {
    const value =
        bucketId === "apac" ? bindings.R2_BUCKET_APAC : bucketId === "wnam" ? bindings.R2_BUCKET_WNAM : undefined;
    return isR2Bucket(value) ? value : null;
}

export class CloudDatabaseResolver implements DatabaseResolver {
    readonly #bindings: CloudSlackStorageBindings;

    constructor(bindings: CloudSlackStorageBindings) {
        this.#bindings = bindings;
    }

    readonly resolve: DatabaseResolver["resolve"] = (sharding) => {
        if (!sharding.hasShard) {
            throw new TenantStorageError();
        }
        const database = configuredD1Binding(sharding.shard.d1ShardId, this.#bindings);
        if (database === null) {
            throw new TenantStorageError();
        }
        return new D1SqlDatabase(database);
    };
}

export class CloudAttachmentStorageResolver implements AttachmentStorageResolver {
    readonly #bindings: CloudSlackStorageBindings;

    constructor(bindings: CloudSlackStorageBindings) {
        this.#bindings = bindings;
    }

    readonly resolve: AttachmentStorageResolver["resolve"] = (sharding) => {
        if (!sharding.hasShard) {
            throw new TenantStorageError();
        }
        const bucket = configuredR2Binding(sharding.shard.r2BucketId, this.#bindings);
        if (bucket === null) {
            throw new TenantStorageError();
        }
        return new R2SlackAttachmentStorage(bucket);
    };
}
