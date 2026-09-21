import * as v from "valibot";
import { createDatabase, type Database } from "../../../schema/d1/database.ts";
import type { AttachmentStorageResolver } from "./attachment-storage-resolver.ts";
import { R2SlackAttachmentStorage } from "./r2-slack-attachment-storage.ts";
import { TenantStorageError } from "./tenant-storage-error.ts";

export interface CloudSlackStorageBindings {
    readonly DATABASE?: unknown;
    readonly ATTACHMENTS?: unknown;
}

const d1BindingSchema = v.object({ batch: v.function(), prepare: v.function() });
const r2BindingSchema = v.object({ get: v.function(), put: v.function() });
function isD1Database(value: unknown): value is D1Database {
    return v.safeParse(d1BindingSchema, value).success;
}
function isR2Bucket(value: unknown): value is R2Bucket {
    return v.safeParse(r2BindingSchema, value).success;
}

function configuredDatabase(bindings: CloudSlackStorageBindings): D1Database | null {
    return isD1Database(bindings.DATABASE) ? bindings.DATABASE : null;
}

export function configuredOrm(bindings: CloudSlackStorageBindings): Database | null {
    const database = configuredDatabase(bindings);
    return database === null ? null : createDatabase(database);
}

export class CloudAttachmentStorageResolver implements AttachmentStorageResolver {
    readonly #bindings: CloudSlackStorageBindings;
    constructor(cx: { readonly config: { readonly bindings: CloudSlackStorageBindings } }) {
        this.#bindings = cx.config.bindings;
    }
    readonly resolve: AttachmentStorageResolver["resolve"] = () => {
        if (!isR2Bucket(this.#bindings.ATTACHMENTS)) {
            throw new TenantStorageError();
        }
        return new R2SlackAttachmentStorage(this.#bindings.ATTACHMENTS);
    };
}
