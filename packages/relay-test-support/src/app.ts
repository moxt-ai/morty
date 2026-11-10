import { createRelayApplication, RelayAuthenticationConfiguration, type RelayRelayBindings } from "@morty-build/relay";
import type { WorkerRuntimeGateways } from "@morty-build/relay-core";
import { type Env, Hono } from "hono";

export { createRelayGateways } from "@morty-build/relay";
export type { RelayRelayBindings };

/** Bind request defaults in the test adapter, leaving the production app untouched. */
class TestApplication<E extends Env> extends Hono<E> {
    override readonly request: Hono<E>["request"];

    constructor(application: Hono<E>, bindings: E["Bindings"]) {
        super();
        this.request = (input, init, environment, executionContext) =>
            application.request(input, init, environment ?? bindings, executionContext);
        this.route("/", application);
    }
}

/** Share the production Relay boundary across Morty and embedding application tests. */
export function createTestMortyRelayApp(
    options: RelayAuthenticationConfiguration & {
        readonly bindings?: RelayRelayBindings;
    },
    gateways: (environment: RelayRelayBindings) => WorkerRuntimeGateways,
): Hono<{ Bindings: RelayRelayBindings }> {
    const application = createRelayApplication(new RelayAuthenticationConfiguration(options.allowedOrigins), gateways);
    return options.bindings === undefined ? application : new TestApplication(application, options.bindings);
}
