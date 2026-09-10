import * as v from "valibot";

class SessionError extends Error {}

export function waitForClerk<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void operation().then(
            (value) => {
                signal.removeEventListener("abort", abort);
                resolve(value);
            },
            (cause: unknown) => {
                signal.removeEventListener("abort", abort);
                reject(signal.aborted ? signal.reason : cause);
            },
        );
    });
}

const sessionSchema = v.pipe(
    v.object({
        userId: v.pipe(v.string(), v.minLength(1)),
        sessionId: v.pipe(v.string(), v.minLength(1)),
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
        throw new SessionError("FORBIDDEN");
    }
    const token = await waitForClerk(getToken, signal);
    if (!token) {
        throw new SessionError("FORBIDDEN");
    }
    const result = await fetch("/mobius-cloud/api/session", {
        headers: { Authorization: `Bearer ${token}` },
        signal,
    });
    if (!result.ok) {
        throw new SessionError(result.status === 401 ? "FORBIDDEN" : "UNAVAILABLE");
    }
    const body: unknown = await result.json();
    v.parse(sessionSchema, body);
    signal.throwIfAborted();
}
