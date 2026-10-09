import * as v from "valibot";
import {
    anonymousCredentialEntry,
    centralLocalStorage,
    workspaceEntry,
} from "../local-storage/central-local-storage.ts";

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
const workspaceSchema = v.object({
    userId: v.string(),
    projectId: projectIdSchema,
});
const identitySchema = v.pipe(v.object({ token: tokenSchema, ...workspaceSchema.entries }), v.readonly());

/** Stored key name for the anonymous credential, shared with browser tests. */
export const ANONYMOUS_CREDENTIAL_KEY_NAME = anonymousCredentialEntry.key;

function readStoredWorkspace() {
    return centralLocalStorage.read(workspaceEntry);
}
const anonymousSessionSchema = v.pipe(
    v.object({ authentication: v.object({ kind: v.literal("anonymous") }), userId: v.string() }),
    v.readonly(),
);
const transferSchema = v.pipe(v.object({ url: v.pipe(v.string(), v.url()) }), v.readonly());
export type AnonymousIdentity = v.InferOutput<typeof identitySchema>;
export type IdentityTransfer = v.InferOutput<typeof transferSchema>;

/** Whether this browser already holds an anonymous credential, without validating it. */
export function hasStoredAnonymousCredential(): boolean {
    return centralLocalStorage.has(anonymousCredentialEntry);
}
export type WorkspaceLocation =
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

    readonly loadExisting = async (requestSignal: AbortSignal): Promise<AnonymousIdentity | null> => {
        const stored = centralLocalStorage.read(anonymousCredentialEntry);
        if (stored !== null) {
            const session = await this.#anonymousSession(stored, requestSignal);
            if (session !== null) {
                if (session.userId === stored.userId) {
                    return stored;
                }
            }
            centralLocalStorage.remove(anonymousCredentialEntry);
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
        const concurrent = centralLocalStorage.read(anonymousCredentialEntry);
        if (concurrent !== null) {
            const session = await this.#anonymousSession(concurrent, requestSignal);
            if (session !== null) {
                if (session.userId === concurrent.userId) {
                    return concurrent;
                }
            }
        }
        this.#saveIdentity(created);
        return created;
    };

    readonly replaceWorkspace = async (
        locationHint: WorkspaceLocation,
        requestSignal: AbortSignal,
    ): Promise<AnonymousIdentity> => {
        const created = v.parse(
            identitySchema,
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
        centralLocalStorage.remove(anonymousCredentialEntry);
        centralLocalStorage.remove(workspaceEntry);
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

    readonly resolveIdentity = async (token: string, signal: AbortSignal): Promise<AnonymousIdentity> => {
        const parsedToken = v.safeParse(recoveryTokenSchema, token);
        if (!parsedToken.success) {
            throw new Error("Enter a valid recovery token.");
        }
        const projectPart = parsedToken.output.split(".")[1];
        const parsedProjectId = v.parse(projectIdSchema, projectPart);
        const session = await this.#anonymousSession(
            { token: parsedToken.output, projectId: parsedProjectId, userId: "" },
            signal,
        );
        if (session === null) {
            throw new Error("This user token is invalid or no longer active.");
        }
        return { token: parsedToken.output, projectId: parsedProjectId, userId: session.userId };
    };

    readonly saveIdentity = (identity: AnonymousIdentity): void =>
        this.#saveIdentity(v.parse(identitySchema, identity));

    readonly #saveIdentity = (identity: AnonymousIdentity) => {
        centralLocalStorage.write(anonymousCredentialEntry, identity);
        centralLocalStorage.write(workspaceEntry, { userId: identity.userId, projectId: identity.projectId });
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
            if (error instanceof IdentityApiError && error.code === "UNAUTHENTICATED") {
                return null;
            }
            throw error;
        }
    };

    readonly #request = async (path: string, init: RequestInit, requestSignal: AbortSignal): Promise<unknown> => {
        const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]);
        const headers = new Headers(init.headers);
        const workspace = readStoredWorkspace();
        const scopedPath =
            workspace !== null &&
            !path.startsWith("/projects/") &&
            !["/identity/anonymous-users", "/identity/transfers/redeem", "/identity/pairings/redeem"].includes(path)
                ? `/projects/${encodeURIComponent(workspace.projectId)}${path}`
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
            );
        }
        return value;
    };
}

class IdentityApiError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.name = "IdentityApiError";
    }
}
