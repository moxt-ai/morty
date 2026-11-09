import type { HeldRuntimeCredentials } from "./runtime-credentials.ts";

export interface RuntimeConnectionInput {
    readonly channelId: string;
    readonly defaultWorkspace: string;
    readonly pairingId: string;
    readonly relayOrigin: URL;
    readonly runtimeCredential: string;
    readonly runtimeId: string;
}

export type RuntimeConnectionActivation = "active" | "stopped";

/** A saved pairing: the identity a Runtime presents to the relay, and whether it should run. */
export class VerifiedRuntimeConnection {
    readonly kind = "verified";
    readonly activation: RuntimeConnectionActivation;
    readonly channelId: string;
    readonly connectionId: string;
    readonly defaultWorkspace: string;
    readonly installationId: string;
    readonly pairingId: string;
    readonly relayOrigin: URL;
    /** The credential state saved with this pairing; live users read it through the installation store. */
    readonly credentials: HeldRuntimeCredentials;

    readonly runtimeId: string;

    constructor(
        activation: RuntimeConnectionActivation,
        installationId: string,
        connectionId: string,
        channelId: string,
        defaultWorkspace: string,
        pairingId: string,
        relayOrigin: URL,
        credentials: HeldRuntimeCredentials,
        runtimeId: string,
    ) {
        this.activation = activation;
        this.channelId = channelId;
        this.connectionId = connectionId;
        this.defaultWorkspace = defaultWorkspace;
        this.installationId = installationId;
        this.pairingId = pairingId;
        this.relayOrigin = relayOrigin;
        this.credentials = credentials;
        this.runtimeId = runtimeId;
    }
}
