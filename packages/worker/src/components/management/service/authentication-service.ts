import * as v from "valibot";
import type { PlatformProjectGateway } from "../../../gateway/platform-project-gateway.ts";
import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import {
    anonymousToken,
    type Credential,
    type CredentialOperation,
    mayPerform,
    type PermittedCredential,
    sharedLinkTerms,
} from "../entity/authentication/credential.ts";
import type { Session } from "../entity/authentication/session.ts";
import { ManagementError } from "../entity/management-error.ts";
import { PlatformProjectError } from "../entity/platform-project.ts";
import type { IdentityStorage, IdentityTransfer } from "../storage/identity-storage.ts";
import type { AnonymousIdentity } from "../storage/identity-storage-common.ts";

type SessionResult =
    | {
          readonly kind: "authenticated";
          readonly session: Session;
          readonly credentialKind: Credential["kind"];
          /** When this access ends: browser access ends with the link it came through; other access does not expire. */
          readonly accessExpiresAt: number | null;
      }
    | { readonly kind: "unauthenticated" }
    /** The credential was issued for this Project and its access was ended since. */
    | { readonly kind: "revoked" };

type CredentialLookup =
    | { readonly kind: "active"; readonly credential: Credential }
    | { readonly kind: "revoked" }
    | { readonly kind: "unknown" };

type Authorization<Operation extends CredentialOperation> =
    | {
          readonly kind: "authorized";
          readonly credential: PermittedCredential<Operation>;
          readonly token: string;
      }
    | { readonly kind: "unauthenticated" }
    /** The credential was issued for this Project and its access was ended since. */
    | { readonly kind: "revoked" }
    | { readonly kind: "forbidden" };

type EndAccessResult = { readonly kind: "ended" | "unauthenticated" | "forbidden" };

/**
 * Whether the Platform also stopped the Session credentials issued before access was revoked. Unconfirmed, those
 * still work until they expire.
 */
export type IssuedSessionAccess =
    | { readonly kind: "revoked" }
    | { readonly kind: "unconfirmed"; readonly cause: PlatformProjectError };

const SESSION_ACCESS_REVOCATION_ATTEMPTS = 3;

/** Outside the session check, revoked access answers like unknown access, so a retry after a lost reply stays safe. */
function refused(access: { readonly kind: "unauthenticated" | "revoked" | "forbidden" }) {
    return { kind: access.kind === "forbidden" ? "forbidden" : "unauthenticated" } as const;
}

export class AuthenticationService {
    private readonly identities: IdentityStorage;
    readonly #platform: Pick<PlatformProjectGateway, "revokeSessionAccess">;
    readonly #projectId: string | null;

    constructor(cx: {
        readonly config: { readonly bindings: Pick<CloudBindings, "CHAT_PROJECT_ID"> };
        readonly storages: { readonly identities: IdentityStorage };
        readonly gateways: { readonly platformProjects: Pick<PlatformProjectGateway, "revokeSessionAccess"> };
    }) {
        this.identities = cx.storages.identities;
        this.#platform = cx.gateways.platformProjects;
        this.#projectId = cx.config.bindings.CHAT_PROJECT_ID ?? null;
    }

    readonly #lookup = async (token: string | undefined, signal: AbortSignal): Promise<CredentialLookup> => {
        const parsed = v.safeParse(anonymousToken, token);
        if (!parsed.success) {
            return { kind: "unknown" };
        }
        const stored = await this.identities.findCredential(parsed.output, signal);
        if (stored === null) {
            return { kind: "unknown" };
        }
        // Browser access ends at the term its link granted, and with the link when it is revoked.
        if (
            stored.revokedAt !== null ||
            stored.linkRevokedAt !== null ||
            (stored.linkAccessExpiresAt !== null && stored.linkAccessExpiresAt <= Date.now())
        ) {
            return { kind: "revoked" };
        }
        // Only a successfully authenticated token can supply the missing historical fact. Hashes alone cannot.
        const kind =
            stored.kind ??
            (stored.transferId !== null
                ? "browser"
                : parsed.output.startsWith("mobius_recovery_v1.")
                  ? "recovery"
                  : "local");
        let credential: Credential;
        switch (kind) {
            case "browser":
                if (stored.transferId === null || stored.linkAccessExpiresAt === null) {
                    return { kind: "unknown" };
                }
                credential = {
                    kind,
                    credentialId: stored.credentialId,
                    userId: stored.userId,
                    transferId: stored.transferId,
                    browserId: stored.browserId ?? stored.credentialId,
                    accessExpiresAt: stored.linkAccessExpiresAt,
                };
                break;
            case "local":
            case "recovery":
                if (stored.transferId !== null || stored.browserId !== null) {
                    return { kind: "unknown" };
                }
                credential = { kind, credentialId: stored.credentialId, userId: stored.userId };
                break;
            default:
                return { kind: "unknown" };
        }
        if (stored.kind === null) {
            await this.identities.identifyLegacyCredential(stored.credentialId, kind, signal);
        }
        return { kind: "active", credential };
    };

    readonly session = async (token: string | undefined, signal: AbortSignal): Promise<SessionResult> => {
        const found = await this.#lookup(token, signal);
        switch (found.kind) {
            case "active":
                return {
                    kind: "authenticated",
                    session: { authentication: { kind: "anonymous" }, userId: found.credential.userId },
                    accessExpiresAt: found.credential.kind === "browser" ? found.credential.accessExpiresAt : null,
                    credentialKind: found.credential.kind,
                };
            case "revoked":
                return { kind: "revoked" };
            case "unknown":
                return { kind: "unauthenticated" };
        }
    };

    readonly createAnonymous = async (
        userId: string,
        projectId: string,
        signal: AbortSignal,
        token: string,
    ): Promise<AnonymousIdentity> => {
        const identity = await this.identities.createAnonymous(userId, projectId, Date.now(), signal, token);
        if (identity === null) {
            throw new ManagementError("LOCAL_CREDENTIAL_UNAVAILABLE", "The credential is no longer available.", 409);
        }
        return identity;
    };

    /** The one check of which credential kinds may perform an operation; the rule itself is `mayPerform`. */
    readonly authorize = async <Operation extends CredentialOperation>(
        token: string | undefined,
        operation: Operation,
        signal: AbortSignal,
    ): Promise<Authorization<Operation>> => {
        if (token === undefined) {
            return { kind: "unauthenticated" };
        }
        const found = await this.#lookup(token, signal);
        switch (found.kind) {
            case "active":
                return mayPerform(found.credential, operation)
                    ? { kind: "authorized", credential: found.credential, token }
                    : { kind: "forbidden" };
            case "revoked":
                return { kind: "revoked" };
            case "unknown":
                return { kind: "unauthenticated" };
        }
    };

    readonly createTransfer = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<IdentityTransfer | null> => {
        const access = await this.authorize(token, "shareAccess", signal);
        if (access.kind !== "authorized") {
            return null;
        }
        const now = Date.now();
        return await this.identities.createTransfer(
            access.credential.userId,
            access.token,
            now,
            sharedLinkTerms(access.credential, now),
            signal,
        );
    };

    readonly createRecoveryToken = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<
        | { readonly kind: "issued"; readonly token: string }
        | { readonly kind: "unauthenticated" }
        | { readonly kind: "forbidden" }
    > => {
        const access = await this.authorize(token, "issueRecoveryCredential", signal);
        if (access.kind !== "authorized") {
            return refused(access);
        }
        const issued = await this.identities.createRecoveryToken(
            access.credential.userId,
            access.token,
            Date.now(),
            signal,
        );
        return issued === null ? { kind: "unauthenticated" } : { kind: "issued", token: issued };
    };

    readonly redeemTransfer = async (
        code: string,
        replaces: string | null,
        signal: AbortSignal,
    ): Promise<AnonymousIdentity | null> => await this.identities.redeemTransfer(code, replaces, Date.now(), signal);

    readonly revokeAllAccess = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<
        | { readonly kind: "revoked"; readonly sessionAccess: IssuedSessionAccess }
        | { readonly kind: "unauthenticated" | "forbidden" }
    > => {
        const access = await this.authorize(token, "revokeAllAccess", signal);
        if (access.kind !== "authorized") {
            return refused(access);
        }
        await this.identities.revokeOtherAccess(access.credential.userId, access.token, Date.now(), signal);
        // Revoked access can no longer obtain Session credentials; those it already holds end only at the Platform.
        return { kind: "revoked", sessionAccess: await this.#revokeIssuedSessionAccess(signal) };
    };

    /** Revoking is safe to repeat, so a failure the Platform may recover from is retried a bounded number of times. */
    readonly #revokeIssuedSessionAccess = async (signal: AbortSignal): Promise<IssuedSessionAccess> => {
        const projectId = this.#projectId;
        if (projectId === null) {
            throw new Error("Access is revoked only inside its Project");
        }
        for (let attempt = 1; ; attempt += 1) {
            try {
                await this.#platform.revokeSessionAccess(projectId, signal);
                return { kind: "revoked" };
            } catch (cause) {
                signal.throwIfAborted();
                if (!(cause instanceof PlatformProjectError)) {
                    throw cause;
                }
                if (cause.status < 500 || attempt === SESSION_ACCESS_REVOCATION_ATTEMPTS) {
                    return { kind: "unconfirmed", cause };
                }
            }
        }
    };

    readonly endBrowserAccess = async (token: string | undefined, signal: AbortSignal): Promise<EndAccessResult> => {
        const access = await this.authorize(token, "endBrowserAccess", signal);
        if (access.kind !== "authorized") {
            return refused(access);
        }
        return {
            kind: (await this.identities.revokeBrowserAccess(access.credential, Date.now(), signal))
                ? "ended"
                : "unauthenticated",
        };
    };

    readonly retireLocalCredential = async (token: string | undefined, signal: AbortSignal): Promise<EndAccessResult> =>
        await this.#revokeCredential(token, "retireLocalCredential", signal);

    readonly revokeRecoveryCredential = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<EndAccessResult> => await this.#revokeCredential(token, "revokeRecoveryCredential", signal);

    readonly #revokeCredential = async (
        token: string | undefined,
        operation: "retireLocalCredential" | "revokeRecoveryCredential",
        signal: AbortSignal,
    ): Promise<EndAccessResult> => {
        const access = await this.authorize(token, operation, signal);
        if (access.kind !== "authorized") {
            return refused(access);
        }
        return {
            kind: (await this.identities.revokeCredential(access.credential, Date.now(), signal))
                ? "ended"
                : "unauthenticated",
        };
    };
}
