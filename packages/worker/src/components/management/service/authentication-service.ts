import type { Session } from "../entity/authentication/session.ts";
import type { IdentityStorage, IdentityTransfer } from "../storage/identity-storage.ts";
import type { AnonymousIdentity } from "../storage/identity-storage-common.ts";

type SessionResult =
    | { readonly kind: "authenticated"; readonly session: Session }
    | { readonly kind: "unauthenticated" };

export class AuthenticationService {
    private readonly identities: IdentityStorage;

    constructor(cx: { readonly storages: { readonly identities: IdentityStorage } }) {
        this.identities = cx.storages.identities;
    }

    readonly session = async (token: string | undefined, signal: AbortSignal): Promise<SessionResult> => {
        if (token === undefined) {
            return { kind: "unauthenticated" };
        }
        const userId = await this.identities.authenticateAnonymous(token, signal);
        return userId === null
            ? { kind: "unauthenticated" }
            : { kind: "authenticated", session: { authentication: { kind: "anonymous" }, userId } };
    };

    readonly createAnonymous = async (
        userId: string,
        projectId: string,
        signal: AbortSignal,
    ): Promise<AnonymousIdentity> => await this.identities.createAnonymous(userId, projectId, Date.now(), signal);

    readonly createTransfer = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<IdentityTransfer | null> => {
        if (token === undefined) {
            return null;
        }
        const userId = await this.identities.authenticateAnonymous(token, signal);
        if (userId === null) {
            return null;
        }
        return await this.identities.createTransfer(userId, token, Date.now(), signal);
    };

    readonly createRecoveryToken = async (token: string | undefined, signal: AbortSignal): Promise<string | null> => {
        if (token === undefined) {
            return null;
        }
        const userId = await this.identities.authenticateAnonymous(token, signal);
        if (userId === null) {
            return null;
        }
        return await this.identities.createRecoveryToken(userId, token, Date.now(), signal);
    };

    readonly redeemTransfer = async (code: string, signal: AbortSignal): Promise<AnonymousIdentity | null> =>
        await this.identities.redeemTransfer(code, Date.now(), signal);

    readonly revokeAllAccess = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<{ readonly kind: "revoked" | "unauthenticated" | "forbidden" }> => {
        if (token === undefined) {
            return { kind: "unauthenticated" };
        }
        const userId = await this.identities.authenticateAnonymous(token, signal);
        if (userId === null) {
            return { kind: "unauthenticated" };
        }
        // Recovery and shared browser credentials must not gain local administration rights.
        if (!token.startsWith("mobius_anon_v2_") || !(await this.identities.isLocalCredential(token, userId, signal))) {
            return { kind: "forbidden" };
        }
        await this.identities.revokeOtherAccess(userId, token, Date.now(), signal);
        return { kind: "revoked" };
    };

    readonly endRemoteAccess = async (token: string | undefined, signal: AbortSignal) => {
        if (token === undefined) {
            return { kind: "unauthenticated" } as const;
        }
        return await this.identities.endRemoteAccess(token, Date.now(), signal);
    };
}
