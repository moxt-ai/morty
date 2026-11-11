/** What a Session reports about its work: the turn running or being submitted, the last turn's failure, or nothing. */
export type SessionActivityState =
    | { readonly kind: "idle" }
    | { readonly kind: "working"; readonly commandId: string }
    | { readonly kind: "failed"; readonly commandId: string; readonly code: string; readonly message: string };
