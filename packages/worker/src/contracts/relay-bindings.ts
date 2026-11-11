import * as v from "valibot";
import type { CloudBindings } from "./cloud-bindings.ts";
import { durableObjectNamespaceBindingSchema } from "./cloud-bindings.ts";
import { ComputerManagementError } from "./computer-management.ts";

export interface RelayBindings {
    readonly COMPUTER_RELAY: DurableObjectNamespace;
    readonly MORTY_SESSION_SIGNING_SECRET: string;
}

export interface ConfiguredRelayBindings extends RelayBindings {
    readonly MORTY_ALLOWED_ORIGINS: string;
    readonly APP_ORIGIN?: string;
}

const bindings = v.object({
    COMPUTER_RELAY: durableObjectNamespaceBindingSchema(),
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
