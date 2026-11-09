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
    readonly connectionId: string;
    readonly defaultWorkspace: string;
    readonly installationId: string;
    readonly relayOrigin: URL;
    /**
     * The credential issued when the connection was paired. It rotates on every connection, so the credential the
     * Relay accepts now is read through `RuntimeInstallationStore.runtimeCredentials`.
     */
    readonly runtimeCredential: string;

    constructor(
        activation: RuntimeConnectionActivation,
        installationId: string,
        connectionId: string,
        computerId: string,
        defaultWorkspace: string,
        relayOrigin: URL,
        runtimeCredential: string,
    ) {
        this.activation = activation;
        this.computerId = computerId;
        this.connectionId = connectionId;
        this.defaultWorkspace = defaultWorkspace;
        this.installationId = installationId;
        this.relayOrigin = relayOrigin;
        this.runtimeCredential = runtimeCredential;
    }
}
