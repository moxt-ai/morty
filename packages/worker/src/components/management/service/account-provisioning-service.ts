import * as v from "valibot";
import { createRelayAccessServices } from "../../../../../relay/src/relay-worker.ts";
import { relayEnvironment } from "../../../gateway/local-relay.ts";
import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import { computerManagementSchema } from "../entity/computer-management.ts";
import type { ProjectLocationHint } from "../util/project-location.ts";

export async function provisionAccount(
    bindings: CloudBindings,
    userId: string,
    reference: string,
    location: ProjectLocationHint,
    signal: AbortSignal,
) {
    const services = createRelayAccessServices(relayEnvironment(bindings));
    return v.parse(
        computerManagementSchema,
        await services.control.provisionMachineAccount(
            userId,
            "Morty",
            `cloud-${reference}`,
            reference,
            location,
            signal,
        ),
    );
}
