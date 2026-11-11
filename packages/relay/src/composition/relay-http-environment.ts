import type { LocalSessionOperations, RelayContext } from "@morty-build/relay";
import type {
    SessionAccessService,
    SessionAccessTarget,
} from "../components/runtime/service/session-access-service.ts";

type SessionExecution =
    | { readonly kind: "remote" }
    | { readonly kind: "local"; readonly operations: LocalSessionOperations };

export type RelayHttpEnvironment = {
    readonly Variables: {
        readonly relay: RelayContext;
        readonly sessionAccess: SessionAccessService;
        readonly allowedOrigins: ReadonlySet<string>;
        readonly sessionExecution: SessionExecution;
        readonly sessionAccessTarget: SessionAccessTarget;
        readonly signal: AbortSignal;
    };
};
