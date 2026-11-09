export interface MachineAccountDirectory {
    readonly requireActiveAccount: (projectId: string, signal: AbortSignal) => Promise<void>;
}
