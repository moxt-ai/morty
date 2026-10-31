import * as v from "valibot";
import { anonymousToken, type Credential } from "../entity/authentication/credential.ts";
import type { Session } from "../entity/authentication/session.ts";
import { ManagementError } from "../entity/management-error.ts";
import type { IdentityStorage, IdentityTransfer } from "../storage/identity-storage.ts";
import type { AnonymousIdentity } from "../storage/identity-storage-common.ts";

type SessionResult =
    | { readonly kind: "authenticated"; readonly session: Session; readonly credentialKind: Credential["kind"] }
    | { readonly kind: "unauthenticated" }
    /** The credential was issued for this Project and its access was ended since. */
    | { readonly kind: "revoked" };

type CredentialLookup =
    | { readonly kind: "active"; readonly credential: Credential }
    | { readonly kind: "revoked" }
    | { readonly kind: "unknown" };

type EndAccessResult = { readonly kind: "ended" | "unauthenticated" | "forbidden" };

export class AuthenticationService {
    private readonly identities: IdentityStorage;

    constructor(cx: { readonly storages: { readonly identities: IdentityStorage } }) {
        this.identities = cx.storages.identities;
    }

    readonly #credential = async (token: string | undefined, signal: AbortSignal): Promise<Credential | null> => {
        const found = await this.#lookup(token, signal);
        return found.kind === "active" ? found.credential : null;
    };

    readonly #lookup = async (token: string | undefined, signal: AbortSignal): Promise<CredentialLookup> => {
        const parsed = v.safeParse(anonymousToken, token);
        if (!parsed.success) {
            return { kind: "unknown" };
        }
        const stored = await this.identities.findCredential(parsed.output, signal);
        if (stored === null) {
            return { kind: "unknown" };
        }
        // Revoking a link also ends the browser access it issued.
        if (stored.revokedAt !== null || stored.linkRevokedAt !== null) {
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
                if (stored.transferId === null) {
                    return { kind: "unknown" };
                }
                credential = {
                    kind,
                    credentialId: stored.credentialId,
                    userId: stored.userId,
                    transferId: stored.transferId,
                    browserId: stored.browserId ?? stored.credentialId,
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

    readonly createTransfer = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<IdentityTransfer | null> => {
        if (token === undefined) {
            return null;
        }
        const credential = await this.#credential(token, signal);
        return credential === null
            ? null
            : await this.identities.createTransfer(credential.userId, token, Date.now(), signal);
    };

    readonly createRecoveryToken = async (token: string | undefined, signal: AbortSignal): Promise<string | null> => {
        if (token === undefined) {
            return null;
        }
        const credential = await this.#credential(token, signal);
        return credential === null
            ? null
            : await this.identities.createRecoveryToken(credential.userId, token, Date.now(), signal);
    };

    readonly redeemTransfer = async (
        code: string,
        replaces: string | null,
        signal: AbortSignal,
    ): Promise<AnonymousIdentity | null> => await this.identities.redeemTransfer(code, replaces, Date.now(), signal);

    /** Only a machine's local credential can administer the user's access or Project. */
    readonly localIdentity = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<
        | { readonly kind: "local"; readonly userId: string; readonly token: string }
        | { readonly kind: "unauthenticated" }
        | { readonly kind: "forbidden" }
    > => {
        if (token === undefined) {
            return { kind: "unauthenticated" };
        }
        const credential = await this.#credential(token, signal);
        if (credential === null) {
            return { kind: "unauthenticated" };
        }
        if (credential.kind !== "local") {
            return { kind: "forbidden" };
        }
        return { kind: "local", userId: credential.userId, token };
    };

    readonly revokeAllAccess = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<{ readonly kind: "revoked" | "unauthenticated" | "forbidden" }> => {
        const local = await this.localIdentity(token, signal);
        if (local.kind !== "local") {
            return local;
        }
        await this.identities.revokeOtherAccess(local.userId, local.token, Date.now(), signal);
        return { kind: "revoked" };
    };

    readonly endBrowserAccess = async (token: string | undefined, signal: AbortSignal): Promise<EndAccessResult> => {
        const credential = await this.#credential(token, signal);
        if (credential === null) {
            return { kind: "unauthenticated" };
        }
        if (credential.kind !== "browser") {
            return { kind: "forbidden" };
        }
        return {
            kind: (await this.identities.revokeBrowserAccess(credential, Date.now(), signal))
                ? "ended"
                : "unauthenticated",
        };
    };

    readonly retireLocalCredential = async (token: string | undefined, signal: AbortSignal): Promise<EndAccessResult> =>
        await this.#revokeCredential(token, "local", signal);

    readonly revokeRecoveryCredential = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<EndAccessResult> => await this.#revokeCredential(token, "recovery", signal);

    readonly #revokeCredential = async (
        token: string | undefined,
        kind: "local" | "recovery",
        signal: AbortSignal,
    ): Promise<EndAccessResult> => {
        const credential = await this.#credential(token, signal);
        if (credential === null) {
            return { kind: "unauthenticated" };
        }
        if (credential.kind !== kind) {
            return { kind: "forbidden" };
        }
        return {
            kind: (await this.identities.revokeCredential(credential, Date.now(), signal))
                ? "ended"
                : "unauthenticated",
        };
    };
}
