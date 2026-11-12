import type { MiddlewareHandler } from "hono";
import type { ConfiguredRelayBindings } from "../../contracts/relay-bindings.ts";
import type { ComputerTargetEnvironment } from "../../http/computer-target.ts";
import type { ComputerInternalService } from "../components/management/service/computer-internal-service.ts";
import type { LocalSessionOperations } from "../components/runtime/service/local-session-operations.ts";
import type {
    SessionAccessService,
    SessionAccessTarget,
} from "../components/runtime/service/session-access-service.ts";
import type { RelayContext } from "../composition/relay-services.ts";

type RelayHttpEnvironment = {
    readonly Variables: {
        readonly relay: RelayContext;
        readonly sessionAccess: SessionAccessService;
        readonly allowedOrigins: ReadonlySet<string>;
        readonly sessionOperations: LocalSessionOperations;
        readonly sessionAccessTarget: SessionAccessTarget;
        readonly signal: AbortSignal;
    };
};

export type RelayProtocolEnvironment = ComputerRouteHttpEnvironment;

export type RelayRouteMiddleware = readonly [
    timeout: MiddlewareHandler<RelayProtocolEnvironment>,
    target: MiddlewareHandler<RelayProtocolEnvironment>,
    initialize: MiddlewareHandler<RelayProtocolEnvironment>,
];

export type ComputerRouteHttpEnvironment = RelayHttpEnvironment & {
    readonly Bindings: ConfiguredRelayBindings;
    readonly Variables: ComputerTargetEnvironment["Variables"] & { readonly computerInternal: ComputerInternalService };
};
