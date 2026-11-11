import { sameNativeSession } from "@morty-build/client/native-session";
import {
    decodeNativeSessionTarget,
    type NativeSessionTarget,
    ProtocolMessageError,
    type SessionAccessGrant,
    type SessionAccessHolder,
} from "@morty-build/client/protocol";
import { ComputerAuthenticationError, ComputerPermission } from "@morty-build/relay-core";
import { SessionAccessCredentialExpiredError, type SessionAccessSigner } from "../entity/session-access-credential.ts";
import type { ComputerManagementService } from "./computer-management-service.ts";

export type SessionAccessTarget =
    | { readonly kind: "session"; readonly computerId: string; readonly target: NativeSessionTarget }
    | { readonly kind: "unavailable" };

/** A verified Session credential: the Session it selects, and the authorization of each operation on it. */
export interface SessionAccess {
    readonly signingKeyId: string;
    readonly issuedAtEpochMilliseconds: number;
    /** The holder and pairing generation the credential carries. */
    readonly grant: SessionAccessGrant;
    readonly expiresAtEpochMilliseconds: number;
    readonly computerId: string;
    readonly authorize: (permission: ComputerPermission, signal: AbortSignal) => Promise<void>;
}

/**
 * A Session credential confines every request to its own Session. An operation the Relay grants Runtime-wide to Runtime
 * read access, such as reading a Session's settings or native history, reads only that Session through it, which is
 * what Session read access permits.
 */
function sessionScopedPermission(permission: ComputerPermission): ComputerPermission {
    return permission === ComputerPermission.RuntimeRead ? ComputerPermission.SessionRead : permission;
}

export class SessionAccessService {
    readonly #control: ComputerManagementService;
    readonly #signer: SessionAccessSigner;

    constructor(control: ComputerManagementService, signer: SessionAccessSigner) {
        this.#control = control;
        this.#signer = signer;
    }

    /**
     * Issues a Session credential bound to the active Runtime pairing and holder. Ending either
     * authority ends the credential; a later pairing cannot restore it.
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
            throw new ComputerAuthenticationError("project_permission_denied", "A selected Session is required");
        }
        const nativeTarget = decodeNativeSessionTarget(target.target);
        if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 900) {
            throw new ComputerAuthenticationError("invalid_request", "The Session credential lifetime is invalid");
        }
        await this.#control.authorizeComputer(target.computerId, ComputerPermission.SessionWrite, signal);
        const generation = await this.#control.currentSessionGeneration(target.computerId, holder, signal);
        if (generation === null) {
            throw new ComputerAuthenticationError("credential_revoked", "The Session access has ended");
        }
        const issuedAtEpochMilliseconds = Date.now();
        const expiresAtEpochMilliseconds = issuedAtEpochMilliseconds + expiresInSeconds * 1_000;
        const credential = await this.#signer.issue({
            expiresAtEpochMilliseconds,
            issuedAtEpochMilliseconds,
            computerId: target.computerId,
            purpose: "session-access",
            grant: { holder, generation },
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
        await this.authorizeSession(target, credentialValue, ComputerPermission.SessionRead, signal);

    readonly authorizeSession = async (
        target: SessionAccessTarget,
        credentialValue: string,
        permission: ComputerPermission,
        signal: AbortSignal,
    ): Promise<SessionAccess> => {
        signal.throwIfAborted();
        const access = await this.authenticate(target, credentialValue, signal);
        await access.authorize(permission, signal);
        return access;
    };

    /**
     * Verifies a Session credential for its selected Session without authorizing any operation. Each operation then
     * authorizes the permission it needs through the Computer routes, narrowed to the one Session the credential selects.
     */
    readonly authenticate = async (
        target: SessionAccessTarget,
        credentialValue: string,
        signal: AbortSignal,
    ): Promise<SessionAccess> => {
        if (target.kind !== "session") {
            throw new ComputerAuthenticationError(
                "project_permission_denied",
                "The credential authorizes only a selected Session",
            );
        }
        let claims: Awaited<ReturnType<SessionAccessSigner["verify"]>>;
        try {
            claims = await this.#signer.verify(credentialValue, Date.now());
        } catch (cause) {
            if (cause instanceof SessionAccessCredentialExpiredError) {
                throw new ComputerAuthenticationError("credential_expired", "The Session credential has expired", {
                    cause,
                });
            }
            if (cause instanceof ProtocolMessageError) {
                throw new ComputerAuthenticationError(
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
            throw new ComputerAuthenticationError(
                "project_permission_denied",
                "The credential authorizes only the selected Session",
            );
        }
        signal.throwIfAborted();
        const computerId = target.computerId;
        return {
            signingKeyId: await this.#signer.keyId(),
            issuedAtEpochMilliseconds: claims.issuedAtEpochMilliseconds,
            grant: claims.grant,
            expiresAtEpochMilliseconds: claims.expiresAtEpochMilliseconds,
            computerId: claims.computerId,
            authorize: async (permission, authorizationSignal) => {
                await this.#control.authorizeSessionCredentialRecord(
                    computerId,
                    sessionScopedPermission(permission),
                    claims.grant,
                    authorizationSignal,
                );
            },
        };
    };
}
