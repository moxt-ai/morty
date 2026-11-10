import type { SessionAccessHolder } from "@morty-build/client/protocol";
import * as v from "valibot";
import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import {
    accessHolder,
    anonymousToken,
    type Credential,
    type CredentialOperation,
    type DeviceAccessDuration,
    issuedLinkTerms,
    mayPerform,
    type PermittedCredential,
    sharedLinkTerms,
} from "../entity/authentication/credential.ts";
import type { Session } from "../entity/authentication/session.ts";
import type { ClientLocation } from "../entity/client-location.ts";
import { ManagementError } from "../entity/management-error.ts";
import { sharingOperationCredential } from "../entity/project-credential.ts";
import type {
    IdentityStorage,
    IdentityTransfer,
    JoiningDevice,
    StoredCredential,
} from "../storage/identity-storage.ts";
import { type AnonymousIdentity, digest } from "../storage/identity-storage-common.ts";

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
          /** Whose access this is; the Session credentials it obtains last only while that access holds. */
          readonly holder: SessionAccessHolder;
      }
    | { readonly kind: "unauthenticated" }
    /**
     * The credential was issued for this Project and no longer grants access: its access ended, or a newer credential
     * of its browser device replaced it. Both keep the response released pages read; the browser that holds a replaced
     * credential reads the newer one it stored.
     */
    | { readonly kind: "revoked" };

type CredentialLookup =
    | { readonly kind: "active"; readonly credential: Credential }
    /** A newer credential of the same browser device replaced it; the device may still hold access. */
    | { readonly kind: "replaced" }
    /** Its access ended: the credential was revoked, or its browser device was ended or reached its term. */
    | { readonly kind: "ended" }
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

/** What a stored credential grants now, read from what storage reports of it and its device. */
function classifyCredential(stored: StoredCredential): CredentialLookup {
    switch (stored.kind) {
        case "local":
        case "recovery":
            return stored.held
                ? {
                      kind: "active",
                      credential: { kind: stored.kind, credentialId: stored.credentialId, userId: stored.userId },
                  }
                : { kind: "ended" };
        case "browser":
            if (stored.replaced) {
                return { kind: "replaced" };
            }
            return stored.accessHeldUntil === null
                ? { kind: "ended" }
                : {
                      kind: "active",
                      credential: {
                          kind: stored.kind,
                          credentialId: stored.credentialId,
                          userId: stored.userId,
                          transferId: stored.transferId,
                          deviceId: stored.deviceId,
                          accessExpiresAt: stored.accessHeldUntil,
                      },
                  };
    }
}

/**
 * Whether `holder`'s access to the computer holds now, by the same rules that authenticate its credentials: a browser
 * device's until its term unless it was ended, a local or recovery credential's until it was revoked.
 */
export async function holdsAccess(
    identities: Pick<IdentityStorage, "holdsAccess">,
    holder: SessionAccessHolder,
    signal: AbortSignal,
): Promise<boolean> {
    return await identities.holdsAccess(holder, Date.now(), signal);
}

/** Outside the session check, revoked access answers like unknown access, so a retry after a lost reply stays safe. */
function refused(access: { readonly kind: "unauthenticated" | "revoked" | "forbidden" }) {
    return { kind: access.kind === "forbidden" ? "forbidden" : "unauthenticated" } as const;
}

export class AuthenticationService {
    private readonly identities: IdentityStorage;
    readonly #commitAccessEnd: CloudBindings["CHAT_END_ACCESS"];
    readonly #computerId: string | null;

    constructor(cx: {
        readonly config: { readonly bindings: Pick<CloudBindings, "CHAT_END_ACCESS" | "CHAT_COMPUTER_ID"> };
        readonly storages: { readonly identities: IdentityStorage };
    }) {
        this.identities = cx.storages.identities;
        this.#commitAccessEnd = cx.config.bindings.CHAT_END_ACCESS;
        this.#computerId = cx.config.bindings.CHAT_COMPUTER_ID ?? null;
    }

    readonly #lookup = async (token: string | undefined, signal: AbortSignal): Promise<CredentialLookup> => {
        const parsed = v.safeParse(anonymousToken, token);
        if (!parsed.success) {
            return { kind: "unknown" };
        }
        const stored = await this.identities.findCredential(parsed.output, Date.now(), signal);
        return stored === null ? { kind: "unknown" } : classifyCredential(stored);
    };

    readonly session = async (token: string | undefined, signal: AbortSignal): Promise<SessionResult> => {
        const found = await this.#lookup(token, signal);
        switch (found.kind) {
            case "active":
                return {
                    kind: "authenticated",
                    session: { authentication: { kind: "anonymous" }, userId: found.credential.userId },
                    accessExpiresAt: found.credential.kind === "browser" ? found.credential.accessExpiresAt : null,
                    holder: accessHolder(found.credential),
                    credentialKind: found.credential.kind,
                };
            case "replaced":
            case "ended":
                return { kind: "revoked" };
            case "unknown":
                return { kind: "unauthenticated" };
        }
    };

    readonly createAnonymous = async (
        userId: string,
        computerId: string,
        signal: AbortSignal,
        token: string,
    ): Promise<AnonymousIdentity> => {
        const identity = await this.identities.createAnonymous(userId, computerId, Date.now(), signal, token);
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
            case "replaced":
            case "ended":
                return { kind: "revoked" };
            case "unknown":
                return { kind: "unauthenticated" };
        }
    };

    /** Shares this access through a link whose device keeps access for `duration`, replacing an unopened link. */
    readonly createTransfer = async (
        token: string | undefined,
        request: {
            readonly operationId: string;
            readonly duration: DeviceAccessDuration;
            readonly replaces: string | null;
        },
        signal: AbortSignal,
    ): Promise<IdentityTransfer | null> => {
        const access = await this.authorize(token, "shareAccess", signal);
        if (access.kind !== "authorized") {
            return null;
        }
        const now = Date.now();
        if (this.#computerId === null) {
            throw new Error("Sharing needs a computer identity");
        }
        const code = await sharingOperationCredential(this.#computerId, access.token, request.operationId, signal);
        const requestHash = await digest(JSON.stringify([request.duration, request.replaces]));
        const issued = await this.identities.createTransfer(
            access.credential.userId,
            access.token,
            now,
            sharedLinkTerms(access.credential, now, request.duration),
            request.replaces,
            { code, requestHash },
            signal,
        );
        if (issued.kind === "conflict") {
            throw new ManagementError(
                "TRANSFER_CONFLICT",
                "This sharing operation changed or its previous link is no longer available. Open a new sharing dialog.",
                409,
            );
        }
        return { code, ...issuedLinkTerms(request.duration, issued) };
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
                const stored = await this.identities.linkedDevices(access.credential.userId, Date.now(), signal);
                const devices = stored.flatMap((device) => {
                    const heldUntil = device.accessHeldUntil;
                    // Only a device that holds access now is listed, with the term it holds it until.
                    return device.deviceId === own || heldUntil === null
                        ? []
                        : [
                              {
                                  id: device.deviceId,
                                  joinedAt: device.joinedAt,
                                  label: device.label,
                                  location:
                                      device.joinedCity === null && device.joinedCountry === null
                                          ? null
                                          : { city: device.joinedCity, country: device.joinedCountry },
                                  addedBy: deviceSharer(device.sharerKind, device.sharerLabel),
                                  accessExpiresAt: heldUntil,
                              },
                          ];
                });
                return { kind: "listed", devices: devices.sort((left, right) => left.joinedAt - right.joinedAt) };
            }
            case "revoked":
                return { kind: "revoked" };
            case "unauthenticated":
            case "forbidden":
                return { kind: "unauthenticated" };
        }
    };

    /** Revokes all access, and replaces the machine's own credential with `successor` so a copy of it ends too. */
    readonly revokeAllAccess = async (
        token: string | undefined,
        successor: string,
        signal: AbortSignal,
    ): Promise<{ readonly kind: "revoked" } | { readonly kind: "unauthenticated" | "forbidden" }> => {
        const access = await this.authorize(token, "revokeAllAccess", signal);
        if (access.kind !== "authorized") {
            return refused(access);
        }
        if (
            !(await this.#endAccess(() =>
                this.identities.revokeAllAccess(access.credential.userId, access.token, successor, Date.now(), signal),
            ))
        ) {
            return { kind: "unauthenticated" };
        }
        return { kind: "revoked" };
    };

    /**
     * Revokes all access except the machine's own credential. Project replacement keeps it until setup has saved the
     * successor Project's identity, and then ends it.
     */
    readonly revokeOtherAccess = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<{ readonly kind: "revoked" } | { readonly kind: "unauthenticated" | "forbidden" }> => {
        const access = await this.authorize(token, "revokeAllAccess", signal);
        if (access.kind !== "authorized") {
            return refused(access);
        }
        await this.#endAccess(async () => {
            await this.identities.revokeOtherAccess(access.credential.userId, access.token, Date.now(), signal);
            return true;
        });
        return { kind: "revoked" };
    };

    /**
     * Disconnects every other browser that joined through a link while the caller keeps its access, so the owner can
     * remove a device without locking themselves out. Only the chat windows of the browsers it ends close.
     */
    readonly endOtherBrowserAccess = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<{ readonly kind: "ended" } | { readonly kind: "unauthenticated" | "forbidden" }> => {
        const access = await this.authorize(token, "endOtherBrowserAccess", signal);
        if (access.kind !== "authorized") {
            return refused(access);
        }
        await this.#endAccess(async () => {
            await this.identities.endOtherBrowserAccess(
                access.credential.userId,
                access.credential.kind === "browser" ? access.credential.deviceId : null,
                Date.now(),
                signal,
            );
            return true;
        });
        return { kind: "ended" };
    };

    /**
     * Ends one other device's access and closes the chat windows open on it; no other window closes. A device whose
     * access already ended is ended still, so retrying is safe.
     */
    readonly endDeviceAccess = async (
        token: string | undefined,
        deviceId: string,
        signal: AbortSignal,
    ): Promise<
        | { readonly kind: "ended" }
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
        if (
            !(await this.#endAccess(() =>
                this.identities.endDeviceAccess(access.credential.userId, deviceId, Date.now(), signal),
            ))
        ) {
            return { kind: "unknown" };
        }
        return { kind: "ended" };
    };

    /**
     * Applies an identity change that may end access to the computer. Every request reads the identities, so once the
     * change commits nothing it ended is authorized again; the result is the committed change alone, and the computer
     * closes the live connections it ended.
     */
    readonly #endAccess = async (change: () => Promise<boolean>): Promise<boolean> => {
        if (this.#commitAccessEnd === undefined) {
            throw new ManagementError("IDENTITY_UNAVAILABLE", "Computer access storage is unavailable.", 503);
        }
        return await this.#commitAccessEnd(change);
    };

    readonly endBrowserAccess = async (token: string | undefined, signal: AbortSignal): Promise<EndAccessResult> => {
        const access = await this.authorize(token, "endBrowserAccess", signal);
        if (access.kind !== "authorized") {
            return refused(access);
        }
        // Ends this browser's device, so every credential of the device stops, including one another tab just received.
        const { userId, deviceId } = access.credential;
        return {
            kind: (await this.#endAccess(() => this.identities.endDeviceAccess(userId, deviceId, Date.now(), signal)))
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
            kind: (await this.#endAccess(() => this.identities.revokeCredential(access.credential, Date.now(), signal)))
                ? "ended"
                : "unauthenticated",
        };
    };
}
