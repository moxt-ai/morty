import type { AttachmentStorageResolver } from "../../src/storage/attachment-storage-resolver";
import type { SlackAttachmentStorage } from "../../src/storage/slack-attachment-storage";
import { TenantStorageError } from "../../src/storage/tenant-storage-error";

class AttachmentBucket implements SlackAttachmentStorage {
    readonly #objects = new Map<string, { readonly body: ArrayBuffer; readonly contentType: string }>();

    readonly get = async (key: string, signal: AbortSignal): Promise<Response | null> => {
        signal.throwIfAborted();
        const object = this.#objects.get(key);
        return object === undefined
            ? null
            : new Response(object.body.slice(0), { headers: { "Content-Type": object.contentType } });
    };

    readonly put = async (key: string, response: Response, contentType: string, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        const body = await response.arrayBuffer();
        signal.throwIfAborted();
        this.#objects.set(key, { body, contentType });
    };
}

// Stateful R2 replacement at the production resolver port: each bucket owns its bytes.
export class InMemoryAttachments implements AttachmentStorageResolver {
    readonly legacy = new AttachmentBucket();
    readonly apac = new AttachmentBucket();
    readonly wnam = new AttachmentBucket();

    readonly resolve: AttachmentStorageResolver["resolve"] = (sharding) => {
        if (!sharding.hasShard) {
            return this.legacy;
        }
        switch (sharding.shard.r2BucketId) {
            case "apac":
                return this.apac;
            case "wnam":
                return this.wnam;
            default:
                throw new TenantStorageError();
        }
    };
}
