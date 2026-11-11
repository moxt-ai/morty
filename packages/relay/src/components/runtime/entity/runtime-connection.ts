export interface RuntimeConnectionIdentity {
    readonly computerId: string;
    readonly connectionEpoch: number;
}

/** A daemon connection the Relay admitted under one pairing generation. */
export interface RuntimeConnection extends RuntimeConnectionIdentity {
    readonly generation: number;
    readonly connectedAt: number;
}

/** The computer's latest daemon connection: still attached, or closed at `disconnectedAt`. */
export type LatestRuntimeConnection =
    | (RuntimeConnection & { readonly kind: "connected" })
    | (RuntimeConnection & { readonly kind: "disconnected"; readonly disconnectedAt: number });
