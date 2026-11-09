import * as v from "valibot";
import { PlatformProjectError } from "../components/management/entity/platform-project.ts";
import {
    type CloudBindings,
    type ProjectStorageBindings,
    projectStorageBindingsSchema,
} from "../infra/cloud-bindings.ts";

export async function accountBindings(
    bindings: CloudBindings,
    accountId: string,
    signal: AbortSignal,
): Promise<CloudBindings & ProjectStorageBindings> {
    signal.throwIfAborted();
    if (bindings.CHAT_ACCOUNT_ID !== accountId) {
        throw new PlatformProjectError("PROJECT_CONTEXT_MISMATCH", "The Morty context is invalid.", 400);
    }
    const parsed = v.safeParse(projectStorageBindingsSchema, bindings);
    if (!parsed.success) {
        throw new PlatformProjectError("PROJECT_STORAGE_UNAVAILABLE", "Morty storage is unavailable.", 503);
    }
    return { ...bindings, ...parsed.output };
}
