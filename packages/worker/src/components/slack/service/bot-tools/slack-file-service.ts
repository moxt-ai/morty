import type { AttachmentStorageResolver } from "../../storage/attachment-storage-resolver";
import type { TenantContext } from "../identity/tenant-context";

export class SlackFileService {
    readonly #storage: AttachmentStorageResolver;

    constructor(cx: { readonly storages: { readonly attachmentStorageResolver: AttachmentStorageResolver } }) {
        const { attachmentStorageResolver: storage } = cx.storages;
        this.#storage = storage;
    }

    readonly download = async (_tenant: TenantContext, key: string, signal: AbortSignal): Promise<Response> => {
        const object = await this.#storage.resolve().get(key, signal);
        if (object === null) {
            return new Response("Not found", { status: 404 });
        }
        const headers = new Headers();
        for (const [name, value] of object.headers) {
            headers.set(name, value);
        }
        headers.set("Cache-Control", "private, max-age=3600");
        headers.set("X-Content-Type-Options", "nosniff");
        return new Response(object.body, { headers, status: object.status });
    };
}
