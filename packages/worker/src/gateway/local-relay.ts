import * as v from "valibot";
import type { ComputerRelay } from "../../../relay/src/durable-objects/computer-relay.ts";
import { createRelayWorker } from "../../../relay/src/relay-worker.ts";
import { ComputerManagementError } from "../components/management/entity/computer-management.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { d1DatabaseBindingSchema, durableObjectNamespaceBindingSchema } from "../infra/cloud-bindings.ts";

const bindings = v.object({
    COMPUTER_RELAY: durableObjectNamespaceBindingSchema<ComputerRelay>(),
    RELAY_DIRECTORY_DATABASE: d1DatabaseBindingSchema,
    MORTY_SESSION_SIGNING_SECRET: v.string(),
    MORTY_ALLOWED_ORIGINS: v.string(),
});
const publicRelay = createRelayWorker();

export function relayEnvironment(input: CloudBindings) {
    const parsed = v.safeParse(bindings, input);
    if (!parsed.success) {
        throw new ComputerManagementError("RELAY_UNAVAILABLE", "Morty relay is not configured.", 503);
    }
    return parsed.output;
}

export async function fetchPublicRelay(
    request: Request,
    input: CloudBindings,
    context?: ExecutionContext,
): Promise<Response> {
    return await publicRelay.fetch(request, relayEnvironment(input), context);
}
