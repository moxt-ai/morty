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
    | { readonly kind: "browser"; readonly transferId: string; readonly browserId: string }
);

/**
 * The credential kinds that may perform each identity or management operation; any other operation accepts every
 * active credential. Browser and recovery access may use and share the Machine, but only the machine's local credential
 * may issue a recovery credential (which ending browser access does not reach), pair a Runtime, bind the Machine or
 * administer access.
 */
const permittedKinds = {
    shareAccess: ["local", "browser", "recovery"],
    issueRecoveryCredential: ["local"],
    pairRuntime: ["local"],
    configureBot: ["local"],
    revokeAllAccess: ["local"],
    replaceProject: ["local"],
    endBrowserAccess: ["browser"],
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
