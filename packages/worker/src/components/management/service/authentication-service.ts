import * as v from "valibot";
import type { PlatformProjectGateway } from "../../../gateway/platform-project-gateway.ts";
import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import {
    accessHolds,
    anonymousToken,
    type Credential,
    type CredentialOperation,
    type DeviceAccessDuration,
    mayPerform,
    type PermittedCredential,
    sharedLinkTerms,
} from "../entity/authentication/credential.ts";
import type { Session } from "../entity/authentication/session.ts";
import type { ClientLocation } from "../entity/client-location.ts";
import { ManagementError } from "../entity/management-error.ts";
import { PlatformProjectError } from "../entity/platform-project.ts";
import type { IdentityStorage, IdentityTransfer, JoiningDevice } from "../storage/identity-storage.ts";
import type { AnonymousIdentity } from "../storage/identity-storage-common.ts";

type SessionResult =
    | {
          readonly kind: "authenticated";
          readonly session: Session;
          readonly credentialKind: Credential["kind"];
          /**
           * When this access ends: a browser's at its device's term, the latest among the links the device opened;
           * other access does not expire.
           */
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

/** Who shared the link a device joined through, as the owner recognizes it. */
export type DeviceSharer =
    | { readonly kind: "computer" }
    | { readonly kind: "recovery" }
    | { readonly kind: "device"; readonly label: string | null };

/** Null when the link's sharer is unknown, such as a credential from before credential kinds were recorded. */
function deviceSharer(kind: Credential["kind"] | null, label: string | null): DeviceSharer | null {
    switch (kind) {
        case "local":
            return { kind: "computer" };
        case "recovery":
            return { kind: "recovery" };
        case "browser":
            return { kind: "device", label };
        case null:
            return null;
    }
}

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
        // Missing authority is never inferred from a token's representation.
        if (stored.kind === null) {
            return { kind: "unknown" };
        }
        const kind = stored.kind;
        let credential: Credential;
        switch (kind) {
            case "browser":
                if (stored.transferId === null || stored.deviceId === null || stored.accessExpiresAt === null) {
                    return { kind: "unknown" };
                }
                credential = {
                    kind,
                    credentialId: stored.credentialId,
                    userId: stored.userId,
                    transferId: stored.transferId,
                    deviceId: stored.deviceId,
                    accessExpiresAt: stored.accessExpiresAt,
                };
                break;
            case "local":
            case "recovery":
                if (stored.transferId !== null || stored.deviceId !== null) {
                    return { kind: "unknown" };
                }
                credential = { kind, credentialId: stored.credentialId, userId: stored.userId };
                break;
            default:
                return { kind: "unknown" };
        }
        if (
            !accessHolds(
                {
                    revokedAt: stored.revokedAt,
                    accessExpiresAt: credential.kind === "browser" ? credential.accessExpiresAt : null,
                },
                Date.now(),
            )
        ) {
            return { kind: "revoked" };
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

    /** Shares this access through a link whose device keeps access for `duration`, replacing an unopened link. */
    readonly createTransfer = async (
        token: string | undefined,
        request: { readonly duration: DeviceAccessDuration; readonly replaces: string | null },
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
            sharedLinkTerms(access.credential, now, request.duration),
            request.replaces,
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
        joining: JoiningDevice,
        token: string,
        signal: AbortSignal,
    ): Promise<AnonymousIdentity | null> =>
        await this.identities.redeemTransfer(code, replaces, joining, token, Date.now(), signal);

    /** The other devices that hold this access through a link now, so its holder can tell when one is new. */
    readonly linkedDevices = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<
        | {
              readonly kind: "listed";
              readonly devices: readonly {
                  readonly id: string;
                  readonly joinedAt: number;
                  readonly label: string | null;
                  readonly location: ClientLocation | null;
                  readonly addedBy: DeviceSharer | null;
                  /** When the device's access ends. */
                  readonly accessExpiresAt: number;
              }[];
          }
        | { readonly kind: "unauthenticated" | "revoked" }
    > => {
        const access = await this.authorize(token, "listDevices", signal);
        switch (access.kind) {
            case "authorized": {
                const own = access.credential.kind === "browser" ? access.credential.deviceId : null;
                const now = Date.now();
                // A device holds access while any of its credentials does; each row carries the device's term.
                const holding = new Map<string, Awaited<ReturnType<IdentityStorage["linkedDevices"]>>[number]>();
                for (const device of await this.identities.linkedDevices(access.credential.userId, signal)) {
                    if (device.deviceId !== own && accessHolds(device, now)) {
                        holding.set(device.deviceId, device);
                    }
                }
                return {
                    kind: "listed",
                    devices: [...holding.values()]
                        .map((device) => ({
                            id: device.deviceId,
                            joinedAt: device.joinedAt,
                            label: device.label,
                            location:
                                device.joinedCity === null && device.joinedCountry === null
                                    ? null
                                    : { city: device.joinedCity, country: device.joinedCountry },
                            addedBy: deviceSharer(device.sharerKind, device.sharerLabel),
                            accessExpiresAt: device.accessExpiresAt,
                        }))
                        .sort((left, right) => left.joinedAt - right.joinedAt),
                };
            }
            case "revoked":
                return { kind: "revoked" };
            case "unauthenticated":
            case "forbidden":
                return { kind: "unauthenticated" };
        }
    };

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

    /**
     * Disconnects every other browser that joined through a link while the caller keeps its access, so the owner can
     * remove a device without locking themselves out. The Platform cannot tell browsers apart, so it closes every chat
     * window opened until now; those of the access that remains reopen with a new Session credential.
     */
    readonly endOtherBrowserAccess = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<
        | { readonly kind: "ended"; readonly sessionAccess: IssuedSessionAccess }
        | { readonly kind: "unauthenticated" | "forbidden" }
    > => {
        const access = await this.authorize(token, "endOtherBrowserAccess", signal);
        if (access.kind !== "authorized") {
            return refused(access);
        }
        await this.identities.endOtherBrowserAccess(
            access.credential.userId,
            access.credential.kind === "browser" ? access.credential.deviceId : null,
            Date.now(),
            signal,
        );
        return { kind: "ended", sessionAccess: await this.#revokeIssuedSessionAccess(signal) };
    };

    /**
     * Ends one other device's access and closes the chat windows open on it. Windows close Project-wide, so this
     * browser's own windows reconnect. A device whose access already ended is ended still, so retrying is safe.
     */
    readonly endDeviceAccess = async (
        token: string | undefined,
        deviceId: string,
        signal: AbortSignal,
    ): Promise<
        | { readonly kind: "ended"; readonly sessionAccess: IssuedSessionAccess }
        | { readonly kind: "own" | "unknown" }
        | { readonly kind: "unauthenticated" | "forbidden" }
    > => {
        const access = await this.authorize(token, "endDeviceAccess", signal);
        if (access.kind !== "authorized") {
            return refused(access);
        }
        if (access.credential.kind === "browser" && access.credential.deviceId === deviceId) {
            return { kind: "own" };
        }
        if (!(await this.identities.endDeviceAccess(access.credential.userId, deviceId, Date.now(), signal))) {
            return { kind: "unknown" };
        }
        return { kind: "ended", sessionAccess: await this.#revokeIssuedSessionAccess(signal) };
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
