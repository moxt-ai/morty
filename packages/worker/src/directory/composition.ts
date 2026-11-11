import * as v from "valibot";
import type { AccountProvisioner } from "../contracts/account-provisioning.ts";
import type { CloudBindings } from "../contracts/cloud-bindings.ts";
import { computerManagementSchema } from "../contracts/computer-management.ts";
import { relayBindings } from "../contracts/relay-bindings.ts";
import { ComputerManagementService } from "./service/computer-management-service.ts";
import { ComputerManagementStorage } from "./storage/computer-management-storage.ts";

type ComputerTargets = ComputerManagementStorage["projects"]["forProject"];

export function computerDirectory(input: CloudBindings, forComputer: ComputerTargets) {
    const bindings = relayBindings(input);
    return new ComputerManagementService(
        new ComputerManagementStorage(bindings.RELAY_DIRECTORY_DATABASE, {
            forProject: forComputer,
        }),
    );
}

export function accountProvisioner(bindings: CloudBindings, forComputer: ComputerTargets): AccountProvisioner {
    return async (userId, reference, location, signal) =>
        v.parse(
            computerManagementSchema,
            await computerDirectory(bindings, forComputer).provisionComputerAccount(
                userId,
                "Morty",
                `cloud-${reference}`,
                reference,
                location,
                signal,
            ),
        );
}
