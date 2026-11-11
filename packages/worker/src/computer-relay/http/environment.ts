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

export type RelayProtocolEnvironment = {
    readonly Variables: Pick<RelayHttpEnvironment["Variables"], "relay" | "signal">;
};

export type ComputerRouteHttpEnvironment = RelayHttpEnvironment & {
    readonly Variables: { readonly computerInternal: ComputerInternalService };
};
