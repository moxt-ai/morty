import type { HeldRuntimeCredentials } from "./runtime-credentials.ts";

export interface RuntimeConnectionInput {
    readonly computerId: string;
    readonly defaultWorkspace: string;
    readonly relayOrigin: URL;
    readonly runtimeCredential: string;
}

export type RuntimeConnectionActivation = "active" | "stopped";

/** A saved pairing: the identity a Runtime presents to the relay, and whether it should run. */
export class VerifiedRuntimeConnection {
    readonly kind = "verified";
    readonly activation: RuntimeConnectionActivation;
    readonly computerId: string;
    /** Fences work from an earlier pairing, even when this computer is paired again with the same identity. */
    readonly pairingGeneration: string;
    readonly defaultWorkspace: string;
    readonly relayOrigin: URL;
    /** The credential state saved with this pairing; live users read it through the installation store. */
    readonly credentials: HeldRuntimeCredentials;

    constructor(
        activation: RuntimeConnectionActivation,
        pairingGeneration: string,
        computerId: string,
        defaultWorkspace: string,
        relayOrigin: URL,
        credentials: HeldRuntimeCredentials,
    ) {
        this.activation = activation;
        this.computerId = computerId;
        this.pairingGeneration = pairingGeneration;
        this.defaultWorkspace = defaultWorkspace;
        this.relayOrigin = relayOrigin;
        this.credentials = credentials;
    }
}
