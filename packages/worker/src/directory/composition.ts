import * as v from "valibot";
import type { AccountProvisioner } from "../contracts/account-provisioning.ts";
import type { CloudBindings } from "../contracts/cloud-bindings.ts";
import type { ComputerAccounts } from "../contracts/computer-accounts.ts";
import { computerManagementSchema } from "../contracts/computer-management.ts";
import { ComputerManagementService } from "./service/computer-management-service.ts";
import { ComputerManagementStorage } from "./storage/computer-management-storage.ts";

type ComputerTargets = (
    computerId: string,
) => ReturnType<ComputerManagementStorage["projects"]["forProject"]> & ComputerAccounts;

export function computerDirectory(_input: CloudBindings, forComputer: ComputerTargets) {
    return new ComputerManagementService(
        new ComputerManagementStorage(
            {
                readActiveComputerScope: (computerId, signal) =>
                    forComputer(computerId).readActiveComputerScope(computerId, signal),
                createComputerAccount: (project, signal) =>
                    forComputer(project.computer_id).createComputerAccount(project, signal),
            },
            {
                forProject: forComputer,
            },
        ),
    );
}

export function accountProvisioner(bindings: CloudBindings, forComputer: ComputerTargets): AccountProvisioner {
    return async (reference, location, signal) =>
        v.parse(
            computerManagementSchema,
            await computerDirectory(bindings, forComputer).provisionComputerAccount(reference, location, signal),
        );
}
