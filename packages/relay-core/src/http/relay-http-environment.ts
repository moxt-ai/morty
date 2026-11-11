import type { RelayContext } from "../di/create-relay-dependencies.ts";

export type RelayHttpEnvironment = {
    readonly Variables: {
        readonly relay: RelayContext;
        readonly signal: AbortSignal;
    };
};
