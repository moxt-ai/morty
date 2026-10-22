import { type Identifier, isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import * as v from "valibot";
import { anonymousCredentialsEntry, centralLocalStorage } from "../local-storage/central-local-storage.ts";
import { CloudApiError, ManagementApi } from "../management/management-api.ts";
import { clearIdentityScope, type IdentityScope, readIdentityScope, writeIdentityScope } from "./identity-scope-url.ts";
import { forgetComputer, rememberComputer, rememberedComputers } from "./remembered-computers.ts";

const tokenSchema = v.pipe(
    v.string(),
    v.regex(
        /^(?:mobius_anon_v2_[A-Za-z0-9_-]{43}|mobius_recovery_v1\.prj_(?:wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43})$/u,
    ),
);
const recoveryTokenSchema = v.pipe(
    v.string(),
    v.regex(/^mobius_recovery_v1\.prj_(?:wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/u),
);
const projectIdSchema = v.pipe(v.string(), v.regex(/^prj_(wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}$/u));
const botIdSchema = v.custom<Identifier>(isIdentifier);
const userIdSchema = v.pipe(v.string(), v.minLength(8), v.maxLength(128));
const identityFields = { token: tokenSchema, botId: botIdSchema, userId: userIdSchema, projectId: projectIdSchema };
const identitySchema = v.pipe(v.object(identityFields), v.readonly());
/** Response of creating an anonymous user, whose Bot is nested under `bot`. */
const createdIdentitySchema = v.pipe(
    v.object({
        token: tokenSchema,
        bot: v.pipe(v.object({ botId: botIdSchema }), v.readonly()),
        userId: userIdSchema,
        projectId: projectIdSchema,
    }),
    v.readonly(),
);

/** Stored key name of the anonymous credential map, shared with browser tests. */
export const ANONYMOUS_CREDENTIAL_KEY_NAME = anonymousCredentialsEntry.key;

const anonymousSessionSchema = v.pipe(
    v.object({ authentication: v.object({ kind: v.literal("anonymous") }), userId: v.string() }),
    v.readonly(),
);
const transferSchema = v.pipe(
    v.object({ expiresAt: v.pipe(v.string(), v.isoTimestamp()), url: v.pipe(v.string(), v.url()) }),
    v.readonly(),
);
export type AnonymousIdentity = v.InferOutput<typeof identitySchema>;
export type IdentityTransfer = v.InferOutput<typeof transferSchema>;

export type DataRegion =
    | "wnam"
    | "enam"
    | "sam"
    | "weur"
    | "eeur"
    | "apac"
    | "apac-ne"
    | "apac-se"
    | "oc"
    | "afr"
    | "me";

interface Options {
    readonly fetchRequest: (request: Request) => Promise<Response>;
    readonly origin: string;
}

export class AnonymousIdentityApi {
    readonly #fetchRequest: (request: Request) => Promise<Response>;
    readonly #origin: string;

    constructor(options: Options) {
        this.#fetchRequest = options.fetchRequest;
        this.#origin = v.parse(v.pipe(v.string(), v.url()), options.origin);
    }

    readonly loadExisting = async (signal: AbortSignal): Promise<AnonymousIdentity | null> => {
        const scope = readIdentityScope();
        return scope === null ? null : await this.loadScope(scope, signal);
    };

    /** Validate one access without navigating or changing recency. */
    readonly loadScope = async (scope: IdentityScope, signal: AbortSignal): Promise<AnonymousIdentity | null> => {
        signal.throwIfAborted();
        const token = readStoredToken(scope.userId);
        if (token === null) {
            this.#forgetScope(scope);
            return null;
        }
        const identity: AnonymousIdentity = { ...scope, token };
        const session = await this.#anonymousSession(identity, signal);
        signal.throwIfAborted();
        if (session?.userId !== identity.userId) {
            this.#forgetScope(scope);
            return null;
        }
        const management = new ManagementApi({
            fetchRequest: this.#fetchRequest,
            origin: this.#origin,
            projectId: identity.projectId,
            getToken: async (requestSignal) => {
                requestSignal.throwIfAborted();
                return identity.token;
            },
        });
        try {
            await management.readBot(identity.botId, signal);
            signal.throwIfAborted();
        } catch (cause) {
            signal.throwIfAborted();
            if (
                cause instanceof CloudApiError &&
                (cause.code === "BOT_NOT_FOUND" || cause.status === 401 || cause.status === 403)
            ) {
                this.#forgetScope(scope);
                return null;
            }
            throw cause;
        }
        rememberComputer(scope);
        return identity;
    };

    readonly loadOrCreate = async (requestSignal: AbortSignal): Promise<AnonymousIdentity> => {
        const existing = await this.loadExisting(requestSignal);
        if (existing !== null) {
            return existing;
        }
        const created = this.#createdIdentity(
            await this.#request("/identity/anonymous-users", { method: "POST" }, requestSignal),
        );
        this.#saveIdentity(created);
        return created;
    };

    readonly replaceIdentity = async (
        locationHint: DataRegion,
        requestSignal: AbortSignal,
    ): Promise<AnonymousIdentity> => {
        const created = this.#createdIdentity(
            await this.#request(
                "/identity/anonymous-users",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ locationHint }),
                },
                requestSignal,
            ),
        );
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
        const scope = readIdentityScope();
        if (scope !== null) {
            this.#forgetScope(scope);
        }
        clearIdentityScope();
        const destination = new URL(window.location.href);
        destination.pathname = "/chat";
        for (const key of ["sessionId", "conversationId", "conversation", "harness", "nativeSessionAction"]) {
            destination.searchParams.delete(key);
        }
        destination.hash = "";
        window.history.replaceState(window.history.state, "", destination);
    };

    readonly createRecoveryToken = async (
        accessToken: string,
        projectId: string,
        signal: AbortSignal,
    ): Promise<string> => {
        const result = v.parse(
            v.object({ token: recoveryTokenSchema }),
            await this.#request(
                `/projects/${encodeURIComponent(v.parse(projectIdSchema, projectId))}/identity/recovery-token`,
                { method: "POST", headers: { authorization: `Bearer ${v.parse(tokenSchema, accessToken)}` } },
                signal,
            ),
        );
        return result.token;
    };

    readonly saveIdentity = (identity: AnonymousIdentity): void =>
        this.#saveIdentity(v.parse(identitySchema, identity));

    readonly #saveIdentity = (identity: AnonymousIdentity) => {
        writeStoredToken(identity.userId, identity.token);
        rememberComputer(identity);
        writeIdentityScope({ botId: identity.botId, projectId: identity.projectId, userId: identity.userId });
    };

    readonly #forgetScope = (scope: IdentityScope) => {
        forgetComputer(scope);
        if (!rememberedComputers().some((computer) => computer.scope.userId === scope.userId)) {
            removeStoredToken(scope.userId);
        }
    };

    /** Maps the nested `bot` of an anonymous-user creation response onto the identity. */
    readonly #createdIdentity = (response: unknown): AnonymousIdentity => {
        const created = v.parse(createdIdentitySchema, response);
        return {
            botId: created.bot.botId,
            projectId: created.projectId,
            token: created.token,
            userId: created.userId,
        };
    };

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
            requestSignal.throwIfAborted();
            if (error instanceof IdentityApiError && (error.status === 401 || error.status === 403)) {
                return null;
            }
            throw error;
        }
    };

    readonly #request = async (path: string, init: RequestInit, requestSignal: AbortSignal): Promise<unknown> => {
        const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(30_000)]);
        const headers = new Headers(init.headers);
        const scope = readIdentityScope();
        const scopedPath =
            scope !== null &&
            !path.startsWith("/projects/") &&
            !["/identity/anonymous-users", "/identity/transfers/redeem"].includes(path)
                ? `/projects/${encodeURIComponent(scope.projectId)}${path}`
                : path;
        const response = await this.#fetchRequest(
            new Request(new URL(`/morty/api${scopedPath}`, this.#origin), { ...init, headers, signal }),
        );
        const value: unknown = response.status === 204 ? null : await response.json();
        signal.throwIfAborted();
        if (!response.ok) {
            const error = v.safeParse(v.object({ error: v.object({ code: v.string(), message: v.string() }) }), value);
            throw new IdentityApiError(
                error.success ? error.output.error.code : "IDENTITY_UNAVAILABLE",
                error.success ? error.output.error.message : "Identity service is unavailable.",
                response.status,
            );
        }
        return value;
    };
}

function readStoredToken(userId: string): string | null {
    return centralLocalStorage.read(anonymousCredentialsEntry)?.[userId] ?? null;
}

function writeStoredToken(userId: string, token: string): void {
    const existing = centralLocalStorage.read(anonymousCredentialsEntry) ?? {};
    const updated: Record<string, string> = {};
    for (const [storedUserId, storedToken] of Object.entries(existing)) {
        if (storedUserId !== userId) {
            updated[storedUserId] = storedToken;
        }
    }
    updated[userId] = token;
    const kept = Object.entries(updated).slice(-10);
    centralLocalStorage.write(anonymousCredentialsEntry, Object.fromEntries(kept));
}

function removeStoredToken(userId: string): void {
    const existing = centralLocalStorage.read(anonymousCredentialsEntry);
    if (existing === null || !(userId in existing)) {
        return;
    }
    const kept = Object.fromEntries(Object.entries(existing).filter(([storedUserId]) => storedUserId !== userId));
    if (Object.keys(kept).length === 0) {
        centralLocalStorage.remove(anonymousCredentialsEntry);
        return;
    }
    centralLocalStorage.write(anonymousCredentialsEntry, kept);
}

export class IdentityApiError extends Error {
    readonly code: string;
    readonly status: number | null;
    constructor(code: string, message: string, status: number | null = null) {
        super(message);
        this.code = code;
        this.status = status;
        this.name = "IdentityApiError";
    }
}
