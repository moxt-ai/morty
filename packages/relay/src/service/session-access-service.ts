import { sameNativeSession } from "@morty-build/client/native-session";
import {
    decodeNativeSessionTarget,
    type NativeSessionTarget,
    ProtocolMessageError,
    type SessionAccessHolder,
} from "@morty-build/client/protocol";
import { ProjectAuthenticationError, ProjectPermission } from "@morty-build/relay-core";
import { SessionAccessCredentialExpiredError, type SessionAccessSigner } from "../entity/session-access-credential.ts";
import type { ComputerManagementService } from "./computer-management-service.ts";

export type SessionAccessTarget =
    | { readonly kind: "session"; readonly computerId: string; readonly target: NativeSessionTarget }
    | { readonly kind: "unavailable" };

/** A verified Session credential: the Session it selects, and the authorization of each operation on it. */
export interface SessionAccess {
    readonly signingKeyId: string;
    readonly issuedAtEpochMilliseconds: number;
    /** Whose access the credential carries. */
    readonly holder: SessionAccessHolder;
    readonly expiresAtEpochMilliseconds: number;
    readonly computerId: string;
    readonly authorize: (permission: ProjectPermission, signal: AbortSignal) => Promise<void>;
}

/**
 * A Session credential confines every request to its own Session. An operation the Relay grants Computer-wide to Computer
 * read access, such as reading a Session's settings or native history, reads only that Session through it, which is
 * what Session read access permits.
 */
function sessionScopedPermission(permission: ProjectPermission): ProjectPermission {
    return permission === ProjectPermission.ComputerRead ? ProjectPermission.SessionRead : permission;
}

export class SessionAccessService {
    readonly #control: ComputerManagementService;
    readonly #signer: SessionAccessSigner;

    constructor(control: ComputerManagementService, signer: SessionAccessSigner) {
        this.#control = control;
        this.#signer = signer;
    }

    /**
     * Issues a Session credential carrying `holder`'s access. It is refused when that access has already ended, as the
     * credential would be refused from its first use.
     */
    readonly issue = async (
        target: SessionAccessTarget,
        expiresInSeconds: number,
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ): Promise<{
        readonly credential: string;
        readonly expiresAt: string;
        readonly computerId: string;
        readonly target: NativeSessionTarget;
    }> => {
        if (target.kind !== "session") {
            throw new ProjectAuthenticationError("project_permission_denied", "A selected Session is required");
        }
        const nativeTarget = decodeNativeSessionTarget(target.target);
        if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 900) {
            throw new ProjectAuthenticationError("invalid_request", "The Session credential lifetime is invalid");
        }
        await this.#control.authorizeProject(target.computerId, ProjectPermission.SessionWrite, signal);
        if (!(await this.#control.holdsAccess(target.computerId, holder, signal))) {
            throw new ProjectAuthenticationError("credential_revoked", "The Session access has ended");
        }
        const issuedAtEpochMilliseconds = Date.now();
        const expiresAtEpochMilliseconds = issuedAtEpochMilliseconds + expiresInSeconds * 1_000;
        const credential = await this.#signer.issue({
            expiresAtEpochMilliseconds,
            issuedAtEpochMilliseconds,
            computerId: target.computerId,
            purpose: "session-access",
            holder,
            target: nativeTarget,
        });
        return {
            credential,
            expiresAt: new Date(expiresAtEpochMilliseconds).toISOString(),
            computerId: target.computerId,
            target: nativeTarget,
        };
    };

    readonly authorizeLiveEvents = async (
        target: SessionAccessTarget,
        credentialValue: string,
        signal: AbortSignal,
    ): Promise<SessionAccess> =>
        await this.authorizeSession(target, credentialValue, ProjectPermission.SessionRead, signal);

    readonly authorizeSession = async (
        target: SessionAccessTarget,
        credentialValue: string,
        permission: ProjectPermission,
        signal: AbortSignal,
    ): Promise<SessionAccess> => {
        signal.throwIfAborted();
        const access = await this.authenticate(target, credentialValue, signal);
        await access.authorize(permission, signal);
        return access;
    };

    /**
     * Verifies a Session credential for its selected Session without authorizing any operation. Each operation then
     * authorizes the permission it needs through the Project routes, narrowed to the one Session the credential selects.
     */
    readonly authenticate = async (
        target: SessionAccessTarget,
        credentialValue: string,
        signal: AbortSignal,
    ): Promise<SessionAccess> => {
        if (target.kind !== "session") {
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The credential authorizes only a selected Session",
            );
        }
        let claims: Awaited<ReturnType<SessionAccessSigner["verify"]>>;
        try {
            claims = await this.#signer.verify(credentialValue, Date.now());
        } catch (cause) {
            if (cause instanceof SessionAccessCredentialExpiredError) {
                throw new ProjectAuthenticationError("credential_expired", "The Session credential has expired", {
                    cause,
                });
            }
            if (cause instanceof ProtocolMessageError) {
                throw new ProjectAuthenticationError(
                    "project_credential_invalid",
                    "The Session credential is invalid",
                    {
                        cause,
                    },
                );
            }
            throw cause;
        }
        if (claims.computerId !== target.computerId || !sameNativeSession(claims.target, target.target)) {
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The credential authorizes only the selected Session",
            );
        }
        signal.throwIfAborted();
        const computerId = target.computerId;
        return {
            signingKeyId: await this.#signer.keyId(),
            issuedAtEpochMilliseconds: claims.issuedAtEpochMilliseconds,
            holder: claims.holder,
            expiresAtEpochMilliseconds: claims.expiresAtEpochMilliseconds,
            computerId: claims.computerId,
            authorize: async (permission, authorizationSignal) => {
                await this.#control.authorizeSessionCredentialRecord(
                    computerId,
                    sessionScopedPermission(permission),
                    claims.holder,
                    authorizationSignal,
                );
            },
        };
    };
}
