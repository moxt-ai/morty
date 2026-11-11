export interface ComputerConnectionIdentity {
    readonly computerId: string;
    readonly connectionEpoch: number;
}

/** A daemon connection the Relay admitted under one pairing generation. */
export interface ComputerConnection extends ComputerConnectionIdentity {
    readonly generation: number;
    readonly connectedAt: number;
}

/** The computer's latest daemon connection: still attached, or closed at `disconnectedAt`. */
export type LatestComputerConnection =
    | (ComputerConnection & { readonly kind: "connected" })
    | (ComputerConnection & { readonly kind: "disconnected"; readonly disconnectedAt: number });
