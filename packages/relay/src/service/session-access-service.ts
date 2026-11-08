import { decodeSessionAccessCredential, isIdentifier, ProtocolMessageError } from "@morty-build/client/protocol";
import { ProjectAuthenticationError, ProjectPermission } from "@morty-build/relay-core";
import { SessionAccessCredentialExpiredError, type SessionAccessSigner } from "../entity/session-access-credential.ts";
import type { AppCredentialAuthenticationService } from "./app-credential-authentication-service.ts";
import type { PlatformControlPlaneService } from "./platform-control-plane-service.ts";

export type SessionAccessTarget =
    | { readonly kind: "session"; readonly projectId: string; readonly sessionId: string }
    | { readonly kind: "unavailable" };

/** A verified Session credential: the Session it selects, and the authorization of each operation on it. */
export interface SessionAccess {
    readonly signingKeyId: string;
    /** The AppCredential that issued the Session credential. */
    readonly credentialId: string;
    readonly issuedAtEpochMilliseconds: number;
    readonly expiresAtEpochMilliseconds: number;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly authorize: (permission: ProjectPermission, signal: AbortSignal) => Promise<void>;
}

/**
 * A Session credential confines every request to its own Session. An operation the Relay grants Runtime-wide to Runtime
 * read access, such as reading a Session's settings or native history, reads only that Session through it, which is
 * what Session read access permits.
 */
/** The live Session views a Project's Runtimes hold, which a revocation of Session access must also end. */
export interface SessionViewers {
    readonly runtimeIds: (signal: AbortSignal) => Promise<readonly string[]>;
    readonly disconnect: (runtimeId: string, revokedThrough: number, signal: AbortSignal) => Promise<void>;
}

async function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, milliseconds);
        signal.addEventListener("abort", abort, { once: true });
    });
}

function sessionScopedPermission(permission: ProjectPermission): ProjectPermission {
    return permission === ProjectPermission.RuntimeRead ? ProjectPermission.SessionRead : permission;
}

export class SessionAccessService {
    readonly #applications: AppCredentialAuthenticationService;
    readonly #control: PlatformControlPlaneService;
    readonly #signer: SessionAccessSigner;

    constructor(
        applications: AppCredentialAuthenticationService,
        control: PlatformControlPlaneService,
        signer: SessionAccessSigner,
    ) {
        this.#applications = applications;
        this.#control = control;
        this.#signer = signer;
    }

    readonly issue = async (
        target: SessionAccessTarget,
        runtimeId: string,
        appCredential: string,
        expiresInSeconds: number,
        signal: AbortSignal,
    ): Promise<{
        readonly credential: string;
        readonly credentialId: string;
        readonly expiresAt: string;
        readonly projectId: string;
        readonly sessionId: string;
    }> => {
        if (target.kind !== "session") {
            throw new ProjectAuthenticationError("project_permission_denied", "A selected Session is required");
        }
        if (!isIdentifier(runtimeId)) {
            throw new ProjectAuthenticationError("invalid_request", "The Runtime identifier is invalid");
        }
        if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 900) {
            throw new ProjectAuthenticationError("invalid_request", "The Session credential lifetime is invalid");
        }
        const access = await this.#control.authorizePlatformCredential(
            target.projectId,
            appCredential,
            ProjectPermission.SessionWrite,
            "",
            signal,
        );
        // A revocation also revokes credentials issued within a clock margin after it, so a credential issued inside
        // that margin would be refused from its first use. Issuing waits the margin out instead: a credential issued
        // after a revocation is never revoked by it.
        const revokedThrough = await this.#control.readSessionAccessRevokedThrough(target.projectId, signal);
        if (revokedThrough !== null && Date.now() <= revokedThrough) {
            await waitFor(revokedThrough + 1 - Date.now(), signal);
        }
        const issuedAtEpochMilliseconds = Date.now();
        const expiresAtEpochMilliseconds = issuedAtEpochMilliseconds + expiresInSeconds * 1_000;
        const credential = await this.#signer.issue(access.publicCredentialId, {
            expiresAtEpochMilliseconds,
            issuedAtEpochMilliseconds,
            projectId: target.projectId,
            purpose: "session-access",
            runtimeId,
            sessionId: target.sessionId,
        });
        return {
            credential,
            credentialId: `sac_${crypto.randomUUID()}`,
            expiresAt: new Date(expiresAtEpochMilliseconds).toISOString(),
            projectId: target.projectId,
            sessionId: target.sessionId,
        };
    };

    /**
     * Revokes every Session credential issued for the Project until now and closes the live views opened with them.
     * The revocation commits first and every request reads it, so closing views only ends them promptly. A failure to
     * close one leaves the revocation in force for the caller to retry; retries do not move the revocation back.
     */
    readonly revoke = async (
        projectId: string,
        appCredential: string,
        viewers: SessionViewers,
        signal: AbortSignal,
    ): Promise<{ readonly revokedThrough: string }> => {
        const revokedThrough = await this.#control.revokeSessionAccess(projectId, appCredential, signal);
        for (const runtimeId of await viewers.runtimeIds(signal)) {
            await viewers.disconnect(runtimeId, revokedThrough, signal);
        }
        return { revokedThrough: new Date(revokedThrough).toISOString() };
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
        let decoded: ReturnType<typeof decodeSessionAccessCredential>;
        try {
            decoded = decodeSessionAccessCredential(credentialValue);
        } catch (cause) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The Session credential is invalid", {
                cause,
            });
        }
        const application = await this.#applications.readActiveCredentialByPublicId(decoded.publicCredentialId, signal);
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
        if (claims.projectId !== target.projectId || claims.sessionId !== target.sessionId) {
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The credential authorizes only the selected Session",
            );
        }
        const projectId = target.projectId;
        return {
            signingKeyId: await this.#signer.keyId(),
            credentialId: application.credential_id,
            issuedAtEpochMilliseconds: claims.issuedAtEpochMilliseconds,
            expiresAtEpochMilliseconds: claims.expiresAtEpochMilliseconds,
            projectId: claims.projectId,
            runtimeId: claims.runtimeId,
            authorize: async (permission, authorizationSignal) => {
                await this.#control.authorizeSessionCredentialRecord(
                    projectId,
                    application,
                    sessionScopedPermission(permission),
                    claims.issuedAtEpochMilliseconds,
                    authorizationSignal,
                );
            },
        };
    };
}
