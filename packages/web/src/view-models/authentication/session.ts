import * as v from "valibot";
import { WorkspaceError, waitForClerk } from "../../cloud/index.ts";

const sessionSchema = v.pipe(
    v.object({
        userId: v.pipe(v.string(), v.minLength(1)),
        sessionId: v.pipe(v.string(), v.minLength(1)),
        organizationId: v.nullable(v.pipe(v.string(), v.minLength(1))),
    }),
    v.readonly(),
);

export async function verifySession(
    expectedSessionId: string,
    activeSessionId: string | undefined,
    getToken: () => Promise<string | null>,
    requestSignal: AbortSignal,
): Promise<void> {
    const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(10_000)]);
    if (activeSessionId !== expectedSessionId) {
        throw new WorkspaceError("FORBIDDEN");
    }
    const token = await waitForClerk(getToken, signal);
    if (!token) {
        throw new WorkspaceError("FORBIDDEN");
    }
    const result = await fetch("/mobius-cloud/api/session", {
        headers: { Authorization: `Bearer ${token}` },
        signal,
    });
    if (!result.ok) {
        throw new WorkspaceError(result.status === 401 ? "FORBIDDEN" : "UNAVAILABLE");
    }
    const body: unknown = await result.json();
    v.parse(sessionSchema, body);
    signal.throwIfAborted();
}
