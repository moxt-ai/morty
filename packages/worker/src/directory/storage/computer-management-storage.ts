import type { SessionAccessHolder } from "@morty-build/client/protocol";
import type { ComputerManagementStore } from "../../computer-relay/components/management/storage/computer-management-store.ts";
import type { ComputerAccounts } from "../../contracts/computer-accounts.ts";
import type { RelayAuditRecord } from "../../contracts/relay/relay-records.ts";

export class ComputerManagementStorage {
    readonly accounts: ComputerAccounts;
    readonly projects: {
        readonly forProject: (
            computerId: string,
        ) => Pick<ComputerManagementStore, "holdsAccess" | "recordAudit" | "readActiveGeneration">;
    };
    constructor(accounts: ComputerAccounts, projects: ComputerManagementStorage["projects"]) {
        this.accounts = accounts;
        this.projects = projects;
    }

    readonly readActiveComputerScope: ComputerAccounts["readActiveComputerScope"] = (computerId, signal) =>
        this.accounts.readActiveComputerScope(computerId, signal);

    /** Whether `holder`'s access to the computer holds now. */
    readonly holdsAccess = async (
        computerId: string,
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ): Promise<boolean> => await this.projects.forProject(computerId).holdsAccess(holder, signal);
    readonly recordAudit = async (audit: RelayAuditRecord, signal: AbortSignal): Promise<void> =>
        await this.projects.forProject(audit.computerId).recordAudit(audit, signal);

    readonly createComputerAccount: ComputerAccounts["createComputerAccount"] = (project, signal) =>
        this.accounts.createComputerAccount(project, signal);
}
