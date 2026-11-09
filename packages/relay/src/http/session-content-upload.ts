import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { ProjectPermission, toHttpError, validateIdentifier } from "@morty-build/relay-core";
import type { SessionAccessService } from "../service/session-access-service.ts";

/** Shared by transport admission and execution; never executes a content write. */
export async function authorizeSessionContentUpload(request: Request, sessions: SessionAccessService) {
    const path = new URL(request.url).pathname;
    const prefix = `${MORTY_API_PREFIX}/v1/computers/`;
    const parts = path.startsWith(prefix) ? path.slice(prefix.length).split("/") : [];
    const [computerId, resource, sessionId, operation, contentKey] = parts;
    if (
        request.method !== "PUT" ||
        parts.length !== 5 ||
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
        const access = await sessions.authorizeSession(
            {
                kind: "session",
                computerId: validateIdentifier(computerId, "project_id"),
                sessionId: validateIdentifier(sessionId, "session_id"),
            },
            credential,
            ProjectPermission.SessionWrite,
            request.signal,
        );
        return { access, sessionId, contentKey };
    } catch (cause) {
        request.signal.throwIfAborted();
        const error = toHttpError(cause);
        return Response.json(error.body, { status: error.status });
    }
}
