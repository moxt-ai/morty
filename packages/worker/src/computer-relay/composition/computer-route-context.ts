import type { ConfiguredRelayBindings } from "../../contracts/relay-bindings.ts";
import type { ComputerService } from "../components/runtime/service/computer-service.ts";
import type { ComputerServices } from "./computer-services.ts";

/** The owning DO composes this context once for its HTTP route groups. */
export interface ComputerRouteContext {
    readonly bindings: ConfiguredRelayBindings;
    readonly services: {
        readonly browser: ComputerServices;
        readonly runtime: ComputerService;
    };
    readonly utilities: {
        readonly connectionOpened: () => Promise<void>;
    };
}
