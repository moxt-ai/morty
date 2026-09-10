import type { AttachmentStorageResolver } from "../../../src/components/slack/storage/attachment-storage-resolver.ts";
import type { SlackAttachmentStorage } from "../../../src/components/slack/storage/slack-attachment-storage.ts";

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

export class InMemoryAttachments implements AttachmentStorageResolver {
    readonly bucket = new AttachmentBucket();
    readonly resolve: AttachmentStorageResolver["resolve"] = () => this.bucket;
}
