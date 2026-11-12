import type { ProjectRow, RelayComputerScopeRow } from "./relay/relay-records.ts";

export interface ComputerAccounts {
    readonly readActiveComputerScope: (
        computerId: string,
        signal: AbortSignal,
    ) => Promise<RelayComputerScopeRow | null>;
    readonly createComputerAccount: (project: ProjectRow, signal: AbortSignal) => Promise<ProjectRow>;
}
