import * as v from "valibot";
import type { AccountProvisioner } from "../../contracts/account-provisioning.ts";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import type { ComputerAccounts } from "../../contracts/computer-accounts.ts";
import { computerManagementSchema } from "../../contracts/computer-management.ts";
import { relayBindings } from "../../contracts/relay-bindings.ts";
import { ComputerManagementService } from "../components/management/service/computer-management-service.ts";
import { ComputerManagementStorage } from "../components/management/storage/computer-management-storage.ts";
import { ComputerRelayGateway } from "../gateway/computer-relay.ts";

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

export function accountProvisioner(bindings: CloudBindings): AccountProvisioner {
    const forComputer: ComputerTargets = (computerId) => new ComputerRelayGateway(relayBindings(bindings), computerId);
    return async (reference, location, signal) =>
        v.parse(
            computerManagementSchema,
            await computerDirectory(bindings, forComputer).provisionComputerAccount(reference, location, signal),
        );
}
