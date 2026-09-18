import * as v from "valibot";

export const ANONYMOUS_CREDENTIAL_KEY = "mobius.anonymous-credential.v2";

const tokenSchema = v.pipe(v.string(), v.regex(/^mobius_anon_v2_[A-Za-z0-9_-]{43}$/u));
const workspaceSchema = v.object({
    userId: v.string(),
    projectId: v.pipe(v.string(), v.regex(/^prj_(wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}$/u)),
});
const identitySchema = v.pipe(v.object({ token: tokenSchema, ...workspaceSchema.entries }), v.readonly());
const WORKSPACE_KEY = "mobius.workspace.v2";

function storedValue(storage: Storage, key: string): unknown {
    const value = storage.getItem(key);
    if (value === null) {
        return null;
    }
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function readStoredWorkspace(storage: Storage) {
    const parsed = v.safeParse(workspaceSchema, storedValue(storage, WORKSPACE_KEY));
    return parsed.success ? parsed.output : null;
}
const anonymousSessionSchema = v.pipe(
    v.object({ authentication: v.object({ kind: v.literal("anonymous") }), userId: v.string() }),
    v.readonly(),
);
const transferSchema = v.pipe(
    v.object({ expiresAt: v.pipe(v.string(), v.isoTimestamp()), url: v.pipe(v.string(), v.url()) }),
    v.readonly(),
);
const bindingSchema = v.variant("kind", [
    v.pipe(v.object({ kind: v.literal("unbound") }), v.readonly()),
    v.pipe(v.object({ kind: v.literal("bound"), userId: v.string() }), v.readonly()),
]);

export type AnonymousIdentity = v.InferOutput<typeof identitySchema>;
export type IdentityTransfer = v.InferOutput<typeof transferSchema>;
export type ClerkBinding = v.InferOutput<typeof bindingSchema>;

interface Options {
    readonly fetchRequest: (request: Request) => Promise<Response>;
    readonly origin: string;
    readonly storage: Storage;
}

export class AnonymousIdentityApi {
    readonly #fetchRequest: (request: Request) => Promise<Response>;
    readonly #origin: string;
    readonly #storage: Storage;

    constructor(options: Options) {
        this.#fetchRequest = options.fetchRequest;
        this.#origin = v.parse(v.pipe(v.string(), v.url()), options.origin);
        this.#storage = options.storage;
    }

    readonly loadExisting = async (requestSignal: AbortSignal): Promise<AnonymousIdentity | null> => {
        const stored = v.safeParse(identitySchema, storedValue(this.#storage, ANONYMOUS_CREDENTIAL_KEY));
        if (stored.success) {
            const session = await this.#anonymousSession(stored.output, requestSignal);
            if (session !== null) {
                if (session.userId === stored.output.userId) {
                    return stored.output;
                }
            }
            this.#storage.removeItem(ANONYMOUS_CREDENTIAL_KEY);
        }
        return null;
    };

    readonly loadOrCreate = async (requestSignal: AbortSignal): Promise<AnonymousIdentity> => {
        const existing = await this.loadExisting(requestSignal);
        if (existing !== null) {
            return existing;
        }
        const created = v.parse(
            identitySchema,
            await this.#request("/identity/anonymous-users", { method: "POST" }, requestSignal),
        );
        const concurrent = v.safeParse(identitySchema, storedValue(this.#storage, ANONYMOUS_CREDENTIAL_KEY));
        if (concurrent.success) {
            const session = await this.#anonymousSession(concurrent.output, requestSignal);
            if (session !== null) {
                if (session.userId === concurrent.output.userId) {
                    return concurrent.output;
                }
            }
        }
        this.#saveIdentity(created);
        return created;
    };

    readonly createTransfer = async (token: string, signal: AbortSignal): Promise<IdentityTransfer> =>
        v.parse(
            transferSchema,
            await this.#request(
                "/identity/transfers",
                { method: "POST", headers: { authorization: `Bearer ${v.parse(tokenSchema, token)}` } },
                signal,
            ),
        );

    readonly redeemTransfer = async (code: string, signal: AbortSignal): Promise<AnonymousIdentity> => {
        const identity = v.parse(
            identitySchema,
            await this.#request(
                "/identity/transfers/redeem",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ code }),
                },
                signal,
            ),
        );
        this.#saveIdentity(identity);
        return identity;
    };

    readonly endRemoteAccess = async (token: string, signal: AbortSignal): Promise<void> => {
        await this.#request(
            "/identity/remote-access",
            { method: "DELETE", headers: { authorization: `Bearer ${v.parse(tokenSchema, token)}` } },
            signal,
        );
        this.#storage.removeItem(ANONYMOUS_CREDENTIAL_KEY);
        this.#storage.removeItem(WORKSPACE_KEY);
    };

    readonly clerkBinding = async (clerkToken: string, signal: AbortSignal): Promise<ClerkBinding> =>
        v.parse(
            bindingSchema,
            await this.#request(
                "/identity/clerk-binding",
                { method: "GET", headers: { authorization: `Bearer ${clerkToken}` } },
                signal,
            ),
        );

    readonly bindClerk = async (
        clerkToken: string,
        anonymousToken: string,
        action: "bind" | "discard-local" | "override",
        signal: AbortSignal,
    ) => {
        const bound = v.parse(
            v.pipe(v.object({ kind: v.literal("bound"), userId: v.string() }), v.readonly()),
            await this.#request(
                "/identity/clerk-binding",
                {
                    method: "POST",
                    headers: { authorization: `Bearer ${clerkToken}`, "content-type": "application/json" },
                    body: JSON.stringify({ action, anonymousToken: v.parse(tokenSchema, anonymousToken) }),
                },
                signal,
            ),
        );
        return bound;
    };

    readonly #saveIdentity = (identity: AnonymousIdentity) => {
        this.#storage.setItem(ANONYMOUS_CREDENTIAL_KEY, JSON.stringify(identity));
        this.#storage.setItem(
            WORKSPACE_KEY,
            JSON.stringify({ userId: identity.userId, projectId: identity.projectId }),
        );
    };

    readonly clearLocal = () => {
        this.#storage.removeItem(ANONYMOUS_CREDENTIAL_KEY);
        this.#storage.setItem(WORKSPACE_KEY, JSON.stringify({ kind: "recovery" }));
    };

    readonly needsRecovery = () =>
        v.safeParse(v.object({ kind: v.literal("recovery") }), storedValue(this.#storage, WORKSPACE_KEY)).success;

    readonly #anonymousSession = async (
        identity: AnonymousIdentity,
        requestSignal: AbortSignal,
    ): Promise<v.InferOutput<typeof anonymousSessionSchema> | null> => {
        try {
            return v.parse(
                anonymousSessionSchema,
                await this.#request(
                    `/projects/${encodeURIComponent(identity.projectId)}/session`,
                    {
                        method: "GET",
                        headers: {
                            authorization: `Bearer ${identity.token}`,
                        },
                    },
                    requestSignal,
                ),
            );
        } catch (error) {
            if (error instanceof IdentityApiError && error.code === "UNAUTHENTICATED") {
                return null;
            }
            throw error;
        }
    };

    readonly #request = async (path: string, init: RequestInit, requestSignal: AbortSignal): Promise<unknown> => {
        const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]);
        const headers = new Headers(init.headers);
        const workspace = readStoredWorkspace(this.#storage);
        const scopedPath =
            workspace !== null &&
            !path.startsWith("/projects/") &&
            !["/identity/anonymous-users", "/identity/transfers/redeem", "/identity/pairings/redeem"].includes(path)
                ? `/projects/${encodeURIComponent(workspace.projectId)}${path}`
                : path;
        const response = await this.#fetchRequest(
            new Request(new URL(`/mobius-cloud/api${scopedPath}`, this.#origin), { ...init, headers, signal }),
        );
        const value: unknown = response.status === 204 ? null : await response.json();
        signal.throwIfAborted();
        if (!response.ok) {
            const error = v.safeParse(v.object({ error: v.object({ code: v.string(), message: v.string() }) }), value);
            throw new IdentityApiError(
                error.success ? error.output.error.code : "IDENTITY_UNAVAILABLE",
                error.success ? error.output.error.message : "Identity service is unavailable.",
            );
        }
        return value;
    };
}

export class IdentityApiError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.name = "IdentityApiError";
    }
}
