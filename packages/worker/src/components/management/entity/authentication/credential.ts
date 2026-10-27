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

export const credentialRevocationPaths = {
    local: "/identity/v1/local-credential",
    browser: "/identity/v1/browser-access",
    recovery: "/identity/v1/recovery-credential",
} as const;
