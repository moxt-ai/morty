import { type Identifier, isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import * as v from "valibot";
import { anonymousCredentialsEntry } from "../local-storage/central-local-storage.ts";
import { CloudApiError, ManagementApi } from "../management/management-api.ts";
import {
    type IdentityScope,
    leaveComputerAddress,
    readIdentityScope,
    writeIdentityScope,
} from "./identity-scope-url.ts";
import {
    forgetComputer,
    forgetComputerAccess,
    rememberComputer,
    saveAccess,
    storedToken,
    storedTokenForProject,
    withStoredAccessLock,
} from "./remembered-computers.ts";

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
/**
 * The Project a well-formed transfer code names, or null when the code cannot
 * name one. A code that was already redeemed in this browser still names its
 * Project, which is what lets a dead link fall back to the access it issued.
 */
export function transferCodeProject(code: string): string | null {
    const parts = code.split(".");
    return parts.length === 3 && parts[0] === "mobius_transfer_v2" ? (parts[1] ?? null) : null;
}

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
const credentialRevocationPathSchema = v.picklist([
    "/identity/v1/local-credential",
    "/identity/v1/browser-access",
    "/identity/v1/recovery-credential",
]);
export type AnonymousIdentity = v.InferOutput<typeof identitySchema>;
export type IdentityTransfer = v.InferOutput<typeof transferSchema>;

/**
 * What checking access this browser stores found. Access that no longer opens its computer is forgotten either way;
 * `revoked` is the Worker reporting that the access was ended, `gone` is any other access that stopped opening it.
 */
export type AccessCheck =
    | { readonly kind: "open"; readonly identity: AnonymousIdentity }
    | { readonly kind: "revoked" }
    | { readonly kind: "gone" };

/** The reason the Worker gives, beside UNAUTHENTICATED, for a credential whose access was ended. */
const ACCESS_REVOKED = "ACCESS_REVOKED";

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

    readonly loadScope = async (scope: IdentityScope, signal: AbortSignal): Promise<AnonymousIdentity | null> => {
        const checked = await this.checkScope(scope, signal);
        return checked.kind === "open" ? checked.identity : null;
    };

    /**
     * Validate one access without navigating or changing recency. Access another tab replaced while the check ran,
     * including a replacement still being saved, is checked in turn instead of being forgotten with the access it
     * replaced.
     */
    readonly checkScope = async (scope: IdentityScope, signal: AbortSignal): Promise<AccessCheck> => {
        for (;;) {
            signal.throwIfAborted();
            const token = storedToken(scope.userId);
            if (token === null) {
                forgetComputer(scope);
                return { kind: "gone" };
            }
            const checked = await this.#checkAccess({ ...scope, token }, signal);
            if (checked.kind === "open") {
                rememberComputer(scope);
                return checked;
            }
            // A tab replacing this access holds the lock until it saves the replacement, so forgetting waits for it
            // and checks the replacement instead.
            if (await withStoredAccessLock(signal, async () => forgetComputerAccess(scope, token))) {
                return checked;
            }
        }
    };

    /** Whether the access still opens its computer. */
    readonly #checkAccess = async (identity: AnonymousIdentity, signal: AbortSignal): Promise<AccessCheck> => {
        const session = await this.#anonymousSession(identity, signal);
        signal.throwIfAborted();
        if (session === "revoked") {
            return { kind: "revoked" };
        }
        if (session?.userId !== identity.userId) {
            return { kind: "gone" };
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
                return { kind: "gone" };
            }
            throw cause;
        }
        return { kind: "open", identity };
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

    /**
     * Opens a link in this browser. A browser keeps one access per user: the access it already holds for the link's
     * Project is replaced by the new one, which also takes over the links it came from.
     */
    readonly redeemTransfer = async (code: string, signal: AbortSignal): Promise<AnonymousIdentity> =>
        await withStoredAccessLock(signal, () => this.#redeemTransfer(code, signal));

    readonly #redeemTransfer = async (code: string, signal: AbortSignal): Promise<AnonymousIdentity> => {
        const projectId = transferCodeProject(code);
        const replaces = projectId === null ? null : storedTokenForProject(projectId);
        const identity = v.parse(
            identitySchema,
            await this.#request(
                "/identity/transfers/redeem",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ code, ...(replaces === null ? {} : { replaces }) }),
                },
                signal,
            ),
        );
        this.#saveIdentity(identity);
        return identity;
    };

    readonly endRemoteAccess = async (token: string, signal: AbortSignal): Promise<void> => {
        const headers = { authorization: `Bearer ${v.parse(tokenSchema, token)}` };
        const session = await this.#response("/session", { method: "GET", headers }, signal);
        await session.body?.cancel();
        // The Worker names the deletion that ends this credential's kind.
        const path = v.parse(credentialRevocationPathSchema, session.headers.get("Morty-Credential-Revocation"));
        await this.#request(path, { method: "DELETE", headers }, signal);
        const scope = readIdentityScope();
        if (scope !== null) {
            forgetComputer(scope);
        }
        leaveComputerAddress();
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
        const scope = { botId: identity.botId, projectId: identity.projectId, userId: identity.userId };
        saveAccess(scope, identity.token);
        writeIdentityScope(scope);
    };

    readonly #anonymousSession = async (
        identity: AnonymousIdentity,
        requestSignal: AbortSignal,
    ): Promise<v.InferOutput<typeof anonymousSessionSchema> | "revoked" | null> => {
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
            if (error instanceof IdentityApiError && error.status === 401 && error.reason === ACCESS_REVOKED) {
                return "revoked";
            }
            if (error instanceof IdentityApiError && (error.status === 401 || error.status === 403)) {
                return null;
            }
            throw error;
        }
    };

    readonly #request = async (path: string, init: RequestInit, requestSignal: AbortSignal): Promise<unknown> => {
        const response = await this.#response(path, init, requestSignal);
        const value: unknown = response.status === 204 ? null : await response.json();
        requestSignal.throwIfAborted();
        return value;
    };

    readonly #response = async (path: string, init: RequestInit, requestSignal: AbortSignal): Promise<Response> => {
        const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(30_000)]);
        const headers = new Headers(init.headers);
        const scope = readIdentityScope();
        const scopedPath =
            scope !== null && !path.startsWith("/projects/") && path !== "/identity/transfers/redeem"
                ? `/projects/${encodeURIComponent(scope.projectId)}${path}`
                : path;
        const response = await this.#fetchRequest(
            new Request(new URL(`/morty/api${scopedPath}`, this.#origin), { ...init, headers, signal }),
        );
        signal.throwIfAborted();
        if (!response.ok) {
            const value: unknown = await response.json();
            signal.throwIfAborted();
            const error = v.safeParse(
                v.object({
                    error: v.object({ code: v.string(), message: v.string(), reason: v.optional(v.string()) }),
                }),
                value,
            );
            throw new IdentityApiError(
                error.success ? error.output.error.code : "IDENTITY_UNAVAILABLE",
                error.success ? error.output.error.message : "Identity service is unavailable.",
                response.status,
                error.success ? (error.output.error.reason ?? null) : null,
            );
        }
        return response;
    };
}

export class IdentityApiError extends Error {
    readonly code: string;
    readonly status: number | null;
    /** The finer cause the Worker names beside `code`, when it names one. */
    readonly reason: string | null;
    constructor(code: string, message: string, status: number | null = null, reason: string | null = null) {
        super(message);
        this.code = code;
        this.status = status;
        this.reason = reason;
        this.name = "IdentityApiError";
    }
}
