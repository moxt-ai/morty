import * as v from "valibot";

export const ANONYMOUS_CREDENTIAL_KEY = "mobius.anonymous-credential.v1";

const tokenSchema = v.pipe(v.string(), v.regex(/^mobius_anon_v1_[A-Za-z0-9_-]{43}$/u));
const identitySchema = v.pipe(v.object({ token: tokenSchema, userId: v.string() }), v.readonly());
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
    readonly fetchRequest?: (request: Request) => Promise<Response>;
    readonly origin: string;
    readonly storage: Storage;
}

export class AnonymousIdentityApi {
    readonly #fetchRequest: (request: Request) => Promise<Response>;
    readonly #origin: string;
    readonly #storage: Storage;

    constructor(options: Options) {
        this.#fetchRequest = options.fetchRequest ?? ((request) => fetch(request));
        this.#origin = v.parse(v.pipe(v.string(), v.url()), options.origin);
        this.#storage = options.storage;
    }

    readonly loadExisting = async (requestSignal: AbortSignal): Promise<AnonymousIdentity | null> => {
        const stored = v.safeParse(tokenSchema, this.#storage.getItem(ANONYMOUS_CREDENTIAL_KEY));
        if (stored.success) {
            const session = await this.#anonymousSession(stored.output, requestSignal);
            if (session !== null) {
                return { token: stored.output, userId: session.userId };
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
        const concurrent = v.safeParse(tokenSchema, this.#storage.getItem(ANONYMOUS_CREDENTIAL_KEY));
        if (concurrent.success) {
            const session = await this.#anonymousSession(concurrent.output, requestSignal);
            if (session !== null) {
                return { token: concurrent.output, userId: session.userId };
            }
        }
        this.#storage.setItem(ANONYMOUS_CREDENTIAL_KEY, created.token);
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
        this.#storage.setItem(ANONYMOUS_CREDENTIAL_KEY, identity.token);
        return identity;
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
    ): Promise<{ readonly kind: "bound"; readonly userId: string }> =>
        v.parse(
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

    readonly clearLocal = () => this.#storage.removeItem(ANONYMOUS_CREDENTIAL_KEY);

    readonly #anonymousSession = async (
        token: string,
        requestSignal: AbortSignal,
    ): Promise<v.InferOutput<typeof anonymousSessionSchema> | null> => {
        try {
            return v.parse(
                anonymousSessionSchema,
                await this.#request(
                    "/session",
                    { method: "GET", headers: { authorization: `Bearer ${token}` } },
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
        const response = await this.#fetchRequest(
            new Request(new URL(`/mobius-cloud/api${path}`, this.#origin), { ...init, signal }),
        );
        const value: unknown = await response.json();
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
