import type { D1Migration } from "cloudflare:test";
import type { RelayRelayBindings } from "../src/relay-worker.ts";

interface RelayTestBindings extends RelayRelayBindings {
    readonly MORTY_ALLOWED_ORIGINS: string;
    readonly ANONYMOUS_CREATION_LIMITER: RateLimit;
    readonly TEST_RELAY_MIGRATIONS: D1Migration[];
}

declare global {
    namespace Cloudflare {
        interface Env extends RelayTestBindings {}

        interface GlobalProps {
            readonly durableNamespaces: string;
            readonly mainModule: typeof import("../../worker/src/index.ts");
        }
    }
}
