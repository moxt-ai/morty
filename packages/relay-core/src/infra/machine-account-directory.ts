export interface MachineAccountDirectory {
    readonly requireActiveAccount: (computerId: string, signal: AbortSignal) => Promise<void>;
}
