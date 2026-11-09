export interface MachineAccountDirectory {
    readonly requireActiveAccount: (accountId: string, signal: AbortSignal) => Promise<void>;
}
