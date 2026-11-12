import type { SessionAccessHolder } from "@morty-build/client/protocol";
import type { ComputerAccounts } from "../../../../contracts/computer-accounts.ts";
import type { ComputerManagementStore } from "./computer-management-store.ts";

export class ComputerManagementStorage {
    readonly accounts: ComputerAccounts;
    readonly projects: {
        readonly forProject: (
            computerId: string,
        ) => Pick<ComputerManagementStore, "holdsAccess" | "readActiveGeneration">;
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

    readonly createComputerAccount: ComputerAccounts["createComputerAccount"] = (project, signal) =>
        this.accounts.createComputerAccount(project, signal);
}
