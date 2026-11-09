export type ComputerIdentityCredential =
    | { readonly kind: "host"; readonly computerId: string; readonly tokenHash: string }
    | { readonly kind: "daemon"; readonly computerId: string; readonly tokenHash: string }
    | { readonly kind: "project"; readonly computerId: string; readonly tokenHash: string }
    | { readonly kind: "pairing"; readonly computerId: string; readonly tokenHash: string }
    | { readonly kind: "pairing-code"; readonly codeHash: string }
    | { readonly kind: "grant"; readonly computerId: string; readonly grantId: string; readonly secretHash: string };
