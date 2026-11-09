import type { Environment } from "vitest/runtime";
import { builtinEnvironments } from "vitest/runtime";

// These scenarios use a real HTTP server. Node's Fetch implementation supports
// cancelling a compressed response while its body is still being delivered.
export default {
    name: "morty-web",
    viteEnvironment: "client",
    async setup(global, options) {
        const { fetch, Request, Response, Headers, AbortController, AbortSignal } = global;
        const environment = await builtinEnvironments["happy-dom"].setup(global, options);
        Object.assign(global, { fetch, Request, Response, Headers, AbortController, AbortSignal });
        return environment;
    },
} satisfies Environment;
