import * as v from "valibot";
import type { ComputerManagementService } from "../../../../../relay/src/service/computer-management-service.ts";
import { computerManagementSchema } from "../entity/computer-management.ts";
import type { ComputerLocationHint } from "../util/computer-location.ts";

export type AccountProvisioner = (
    userId: string,
    reference: string,
    location: ComputerLocationHint,
    signal: AbortSignal,
) => Promise<v.InferOutput<typeof computerManagementSchema>>;

export async function provisionAccount(
    accounts: ComputerManagementService,
    userId: string,
    reference: string,
    location: ComputerLocationHint,
    signal: AbortSignal,
) {
    return v.parse(
        computerManagementSchema,
        await accounts.provisionMachineAccount(userId, "Morty", `cloud-${reference}`, reference, location, signal),
    );
}
