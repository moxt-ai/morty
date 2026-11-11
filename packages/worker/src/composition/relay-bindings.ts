import * as v from "valibot";
import { ComputerManagementError } from "../components/management/entity/computer-management.ts";
import type { ComputerRelay } from "../do/computer-relay.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { d1DatabaseBindingSchema, durableObjectNamespaceBindingSchema } from "../infra/cloud-bindings.ts";

export interface RelayBindings {
    readonly COMPUTER_RELAY: DurableObjectNamespace<ComputerRelay>;
    readonly RELAY_DIRECTORY_DATABASE: D1Database;
    readonly MORTY_SESSION_SIGNING_SECRET: string;
}

export interface ConfiguredRelayBindings extends RelayBindings {
    readonly MORTY_ALLOWED_ORIGINS: string;
    readonly APP_ORIGIN?: string;
}

const bindings = v.object({
    COMPUTER_RELAY: durableObjectNamespaceBindingSchema<ComputerRelay>(),
    RELAY_DIRECTORY_DATABASE: d1DatabaseBindingSchema,
    MORTY_SESSION_SIGNING_SECRET: v.string(),
    MORTY_ALLOWED_ORIGINS: v.string(),
});

export function relayBindings(input: CloudBindings): ConfiguredRelayBindings {
    const parsed = v.safeParse(bindings, input);
    if (!parsed.success) {
        throw new ComputerManagementError("RELAY_UNAVAILABLE", "Morty relay is not configured.", 503);
    }
    return parsed.output;
}
