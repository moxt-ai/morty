import type { RelayContext } from "./create-relay-dependencies.ts";

export type RelayHttpEnvironment = {
    readonly Variables: {
        readonly relay: RelayContext;
        readonly signal: AbortSignal;
    };
};
