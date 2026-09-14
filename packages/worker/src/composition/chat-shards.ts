import * as v from "valibot";
import { PlatformProjectError } from "../components/management/entity/platform-project.ts";
import { readProjectCredential } from "../components/management/entity/project-credential.ts";
import { PlatformProjectGateway } from "../gateway/platform-project-gateway.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";

export async function projectBindings(
    bindings: CloudBindings,
    projectId: string,
    signal: AbortSignal,
): Promise<CloudBindings> {
    const placement = await new PlatformProjectGateway(bindings).storagePlacement(projectId, signal);
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

export async function chatRequestBindings(request: Request, bindings: CloudBindings): Promise<CloudBindings> {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
    const path = new URL(request.url).pathname;
    if (path === "/mobius-cloud/api/identity/anonymous-users") {
        return bindings;
    }
    const projectId = request.headers.get("X-Mobius-Project-Id");
    const inputKey =
        path === "/mobius-cloud/api/identity/transfers/redeem"
            ? "code"
            : path === "/mobius-cloud/api/identity/pairings/redeem"
              ? "token"
              : null;
    if (request.method === "POST" && inputKey !== null) {
        const input: unknown = await request.clone().json();
        const parsed = v.safeParse(v.record(v.string(), v.unknown()), input);
        const ticket = parsed.success ? readProjectCredential(parsed.output[inputKey]) : null;
        const expectedKind = inputKey === "code" ? "mobius_transfer_v2" : "mobius_pair_v2";
        if (ticket?.kind === expectedKind) {
            return await projectBindings(bindings, ticket.projectId, signal);
        }
    }
    if (projectId !== null) {
        return await projectBindings(bindings, projectId, signal);
    }
    return bindings;
}
