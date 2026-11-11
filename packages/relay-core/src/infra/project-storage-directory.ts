export interface ProjectStorageContext {
    readonly computerId: string;
}

export interface ProjectStorageDirectory {
    /**
     * Locates the storage of a Project the Relay still serves. A Project that is not active, such as one whose App
     * was deleted, resolves to null, so no credential stored for it authorizes anything.
     */
    readonly resolve: (computerId: string, signal: AbortSignal) => Promise<ProjectStorageContext | null>;
}
