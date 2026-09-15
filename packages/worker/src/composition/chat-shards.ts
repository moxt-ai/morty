import { PlatformProjectError } from "../components/management/entity/platform-project.ts";
import { projectRegion } from "../components/management/entity/project-region.ts";
import { PlatformProjectGateway } from "../gateway/platform-project-gateway.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";

export async function projectBindings(
    bindings: CloudBindings,
    projectId: string,
    signal: AbortSignal,
): Promise<CloudBindings> {
    const placement =
        bindings.MOBIUS_WORKER_REGION === "apac" || bindings.MOBIUS_WORKER_REGION === "wnam"
            ? { location: projectRegion(projectId) }
            : await new PlatformProjectGateway(bindings).storagePlacement(projectId, signal);
    const database = placement.location === "apac" ? bindings.CHAT_DATABASE_APAC : bindings.CHAT_DATABASE_WNAM;
    const bucket = placement.location === "apac" ? bindings.CHAT_ATTACHMENTS_APAC : bindings.CHAT_ATTACHMENTS_WNAM;
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
        throw new PlatformProjectError("CHAT_SHARD_UNAVAILABLE", "Chat storage is unavailable.", 503);
    }
    return { ...bindings, DATABASE: database, ATTACHMENTS: bucket, CHAT_PROJECT_ID: projectId };
}
