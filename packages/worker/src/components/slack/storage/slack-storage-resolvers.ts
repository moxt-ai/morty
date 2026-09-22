import { createDatabase, type Database } from "../../../schema/d1/database.ts";
import type { AttachmentStorageResolver } from "./attachment-storage-resolver.ts";
import { R2SlackAttachmentStorage } from "./r2-slack-attachment-storage.ts";

export interface CloudSlackStorageBindings {
    readonly DATABASE: D1Database;
    readonly ATTACHMENTS: R2Bucket;
}

export function configuredOrm(bindings: CloudSlackStorageBindings): Database | null {
    return createDatabase(bindings.DATABASE);
}

export class CloudAttachmentStorageResolver implements AttachmentStorageResolver {
    readonly #bindings: CloudSlackStorageBindings;
    constructor(cx: { readonly config: { readonly bindings: CloudSlackStorageBindings } }) {
        this.#bindings = cx.config.bindings;
    }
    readonly resolve: AttachmentStorageResolver["resolve"] = () => {
        return new R2SlackAttachmentStorage(this.#bindings.ATTACHMENTS);
    };
}
