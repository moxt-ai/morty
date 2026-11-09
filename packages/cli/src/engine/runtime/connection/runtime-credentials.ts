/** The credentials one connection attempt presents: the current credential and the successor saved for it. */
export interface RuntimeCredentialRotation {
    readonly current: string;
    readonly successor: string;
}

/** The credentials a Runtime holds: the one the Relay last accepted and the successor saved for its next connection. */
export interface HeldRuntimeCredentials {
    readonly current: string;
    readonly successor: string | null;
}

/**
 * A Runtime's relay credential, which rotates on every connection. `prepare` saves the successor before any
 * connection presents it, so a crash or a lost reply repeats the same rotation instead of starting another, and
 * `complete` records that the Relay accepted it. A copy of a retired credential then reaches nothing.
 */
export interface RuntimeCredentials {
    readonly prepare: (signal: AbortSignal) => Promise<RuntimeCredentialRotation>;
    readonly complete: (rotation: RuntimeCredentialRotation, signal: AbortSignal) => Promise<void>;
    /**
     * What a request presents. While a connection's rotation is being saved the Relay already holds the successor
     * as current, so a request presents both and the Relay accepts the one it holds.
     */
    readonly held: (signal: AbortSignal) => Promise<HeldRuntimeCredentials>;
}
