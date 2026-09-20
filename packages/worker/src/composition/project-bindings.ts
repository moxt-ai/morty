import { PlatformProjectError } from "../components/management/entity/platform-project.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";

export async function projectBindings(
    bindings: CloudBindings,
    projectId: string,
    signal: AbortSignal,
): Promise<CloudBindings> {
    signal.throwIfAborted();
    if (bindings.CHAT_PROJECT_ID !== projectId) {
        throw new PlatformProjectError("PROJECT_CONTEXT_MISMATCH", "The workspace context is invalid.", 400);
    }
    const database = bindings.DATABASE;
    const bucket = bindings.ATTACHMENTS;
    if (
        typeof database !== "object" ||
        database === null ||
        !("prepare" in database) ||
        typeof database.prepare !== "function" ||
        typeof bucket !== "object" ||
        bucket === null ||
        !("get" in bucket) ||
        typeof bucket.get !== "function"
    ) {
        throw new PlatformProjectError("PROJECT_STORAGE_UNAVAILABLE", "Workspace storage is unavailable.", 503);
    }
    return { ...bindings, DATABASE: database, ATTACHMENTS: bucket, CHAT_PROJECT_ID: projectId };
}
