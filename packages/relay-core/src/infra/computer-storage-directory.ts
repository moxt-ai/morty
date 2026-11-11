export interface ComputerStorageContext {
    readonly computerId: string;
}

export interface ComputerStorageDirectory {
    /**
     * Locates the storage of a Computer the Relay still serves. A Computer that is not active, such as one whose App
     * was deleted, resolves to null, so no credential stored for it authorizes anything.
     */
    readonly resolve: (computerId: string, signal: AbortSignal) => Promise<ComputerStorageContext | null>;
}
