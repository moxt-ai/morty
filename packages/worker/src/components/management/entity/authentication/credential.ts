import * as v from "valibot";

export const anonymousToken = v.pipe(
    v.string(),
    v.regex(
        /^(?:mobius_anon_v2_[A-Za-z0-9_-]{43}|mobius_recovery_v1\.prj_(?:wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43})$/u,
    ),
);

export type Credential = {
    readonly credentialId: string;
    readonly userId: string;
} & (
    | { readonly kind: "local" | "recovery" }
    | {
          readonly kind: "browser";
          readonly transferId: string;
          /** The browser device this credential belongs to. */
          readonly deviceId: string;
          /** When this access ends: the term the link it came through granted. */
          readonly accessExpiresAt: number;
      }
);

/**
 * The one rule for whether a credential still grants access: it is not revoked, and a browser credential is within
 * the term of the link that issued it. Access ends only through these, so ending a browser's access revokes its
 * credentials, and revoking a link only stops it from adding a device.
 */
export function accessHolds(
    credential: { readonly revokedAt: number | null; readonly accessExpiresAt: number | null },
    now: number,
): boolean {
    return credential.revokedAt === null && (credential.accessExpiresAt === null || credential.accessExpiresAt > now);
}

const linkLifetime = 10 * 60 * 1000;
const hour = 60 * 60 * 1000;

/** How long a device added through a link keeps access, chosen when the link is shared. */
export const deviceAccessDurations = ["1h", "1d", "7d", "30d"] as const;
export type DeviceAccessDuration = (typeof deviceAccessDurations)[number];
const deviceAccessLifetimes: Readonly<Record<DeviceAccessDuration, number>> = {
    "1h": hour,
    "1d": 24 * hour,
    "7d": 7 * 24 * hour,
    "30d": 30 * 24 * hour,
};
export const defaultDeviceAccessDuration: DeviceAccessDuration = "1d";

/** What a shared link grants: until when it can add a device, and until when that device keeps access. */
export interface SharedLinkTerms {
    readonly expiresAt: number;
    readonly accessExpiresAt: number;
    /** Whether the sharer's own access ends before the chosen duration, and so ends the device's access too. */
    readonly accessLimitedBySharer: boolean;
}

/**
 * A link adds one device within ten minutes, and that device keeps access for the chosen duration from the link's
 * creation. Neither outlasts the access that shares it, so a device cannot extend its own access by adding another.
 */
export function sharedLinkTerms(sharer: Credential, now: number, duration: DeviceAccessDuration): SharedLinkTerms {
    const limit = sharer.kind === "browser" ? sharer.accessExpiresAt : Number.POSITIVE_INFINITY;
    const chosen = now + deviceAccessLifetimes[duration];
    return {
        expiresAt: Math.min(now + linkLifetime, limit),
        accessExpiresAt: Math.min(chosen, limit),
        accessLimitedBySharer: limit < chosen,
    };
}

/**
 * The credential kinds that may perform each identity or management operation; any other operation accepts every
 * active credential. Browser and recovery access may use and share the Machine and disconnect the other browsers, so
 * whoever notices a device they did not add can remove it without losing their own access. Only the machine's local
 * credential may issue a recovery credential (which ending browser access does not reach), pair a Runtime, bind the
 * Machine or revoke all access.
 */
const permittedKinds = {
    shareAccess: ["local", "browser", "recovery"],
    listDevices: ["local", "browser", "recovery"],
    issueRecoveryCredential: ["local"],
    pairRuntime: ["local"],
    configureBot: ["local"],
    revokeAllAccess: ["local"],
    replaceProject: ["local"],
    endBrowserAccess: ["browser"],
    endOtherBrowserAccess: ["browser", "recovery"],
    endDeviceAccess: ["local", "browser", "recovery"],
    revokeRecoveryCredential: ["recovery"],
    retireLocalCredential: ["local"],
} as const satisfies Record<string, readonly Credential["kind"][]>;

export type CredentialOperation = keyof typeof permittedKinds;
export type PermittedCredential<Operation extends CredentialOperation> = Credential & {
    readonly kind: (typeof permittedKinds)[Operation][number];
};
/** Operations only the machine's local credential may perform. */
export type LocalOperation = {
    [Operation in CredentialOperation]: (typeof permittedKinds)[Operation] extends readonly ["local"]
        ? Operation
        : never;
}[CredentialOperation];

export function mayPerform<Operation extends CredentialOperation>(
    credential: Credential,
    operation: Operation,
): credential is PermittedCredential<Operation> {
    const kinds: readonly Credential["kind"][] = permittedKinds[operation];
    return kinds.includes(credential.kind);
}

export const credentialRevocationPaths = {
    local: "/identity/v1/local-credential",
    browser: "/identity/v1/browser-access",
    recovery: "/identity/v1/recovery-credential",
} as const;
