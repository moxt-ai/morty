import {
    type BucketResolver,
    D1DatabaseAdapter,
    type DatabaseResolver,
} from "@moxt-ai/mobius-relay-cloudflare/adapters";
import { ContentStorageError, PairingDirectoryError } from "@moxt-ai/mobius-relay-core";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { configuredD1Binding, configuredR2Binding } from "./slack-storage-resolvers.ts";

export class CloudMobiusDatabaseResolver implements DatabaseResolver {
    readonly #bindings: CloudBindings;

    constructor(cx: { readonly config: { readonly bindings: CloudBindings } }) {
        this.#bindings = cx.config.bindings;
    }

    readonly resolve: DatabaseResolver["resolve"] = (sharding) => {
        const database = sharding.hasShard ? configuredD1Binding(sharding.shard.d1ShardId, this.#bindings) : null;
        if (database === null) {
            throw new PairingDirectoryError("directory_unavailable", "Workspace storage is unavailable");
        }
        return D1DatabaseAdapter.from(database);
    };
}

export class CloudMobiusBucketResolver implements BucketResolver {
    readonly #bindings: CloudBindings;

    constructor(cx: { readonly config: { readonly bindings: CloudBindings } }) {
        this.#bindings = cx.config.bindings;
    }

    readonly resolve: BucketResolver["resolve"] = (sharding) => {
        const bucket = sharding.hasShard ? configuredR2Binding(sharding.shard.r2BucketId, this.#bindings) : null;
        if (bucket === null || typeof bucket.head !== "function" || typeof bucket.delete !== "function") {
            throw new ContentStorageError("content_storage_unavailable", "Workspace content storage is unavailable");
        }
        return bucket;
    };
}
