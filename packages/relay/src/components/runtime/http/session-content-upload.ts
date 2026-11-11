import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { toHttpError } from "../../../entity/http-error.ts";
import { validateIdentifier } from "../../management/entity/pairing.ts";
import { ProjectPermission } from "../../management/entity/project-authentication.ts";
import type { SessionAccessService } from "../service/session-access-service.ts";

/** Shared by transport admission and execution; never executes a content write. */
export async function authorizeSessionContentUpload(request: Request, sessions: SessionAccessService) {
    const path = new URL(request.url).pathname;
    const prefix = `${MORTY_API_PREFIX}/v1/computers/`;
    const parts = path.startsWith(prefix) ? path.slice(prefix.length).split("/") : [];
    const [computerId, harnessResource, harness, resource, sessionId, operation, contentKey] = parts;
    if (
        request.method !== "PUT" ||
        parts.length !== 7 ||
        harnessResource !== "harnesses" ||
        harness === undefined ||
        resource !== "sessions" ||
        operation !== "content" ||
        computerId === undefined ||
        sessionId === undefined ||
        contentKey === undefined ||
        !/^[a-f0-9]{64}$/u.test(contentKey)
    ) {
        return Response.json(
            { error: { code: "invalid_target", message: "A Session content upload is required" } },
            { status: 400 },
        );
    }
    const credential = (request.headers.get("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
    if (credential === undefined) {
        return Response.json(
            { error: { code: "session_access_required", message: "A Session credential is required" } },
            { status: 401 },
        );
    }
    try {
        const target = {
            harness: validateIdentifier(decodeURIComponent(harness), "harness"),
            sessionId: validateIdentifier(decodeURIComponent(sessionId), "session_id"),
        };
        const access = await sessions.authorizeSession(
            {
                kind: "session",
                computerId: validateIdentifier(computerId, "computer_id"),
                target,
            },
            credential,
            ProjectPermission.SessionWrite,
            request.signal,
        );
        return { access, target, contentKey };
    } catch (cause) {
        request.signal.throwIfAborted();
        const error = toHttpError(cause);
        return Response.json(error.body, { status: error.status });
    }
}
