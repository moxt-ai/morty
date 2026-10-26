// The pinned previous release omits the declaration named by its export map.
// Bind only the consumed exports to that release's actual declarations so API
// changes in the current runtime cannot silently change the previous contract.
declare module "@moxt-ai/mobius-previous/runtime" {
    export const createRuntimeConfig: typeof import("../../../node_modules/@moxt-ai/mobius-previous/dist/runtime/engine.js").createRuntimeConfig;
    export const MobiusRuntimeEngine: typeof import("../../../node_modules/@moxt-ai/mobius-previous/dist/runtime/engine.js").MobiusRuntimeEngine;
    export const RuntimeLocalContext: typeof import("../../../node_modules/@moxt-ai/mobius-previous/dist/runtime/engine.js").RuntimeLocalContext;
    export const InProcessAcpAgentDefinition: typeof import("../../../node_modules/@moxt-ai/mobius-previous/dist/runtime/engine.js").InProcessAcpAgentDefinition;
}
