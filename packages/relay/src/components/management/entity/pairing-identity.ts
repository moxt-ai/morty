export type ComputerIdentityCredential =
    | { readonly kind: "daemon"; readonly computerId: string; readonly tokenHash: string }
    | { readonly kind: "pairing"; readonly computerId: string; readonly tokenHash: string }
    | { readonly kind: "pairing-code"; readonly codeHash: string };
