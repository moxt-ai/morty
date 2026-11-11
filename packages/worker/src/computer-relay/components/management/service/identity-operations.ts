/** Capabilities owned by the computer's durable storage and connection lifecycle. */
export interface IdentityOperations {
    readonly commitAccessEnd: (change: () => Promise<boolean>) => Promise<boolean>;
    readonly credentialKey: (signal: AbortSignal) => Promise<Uint8Array>;
}
