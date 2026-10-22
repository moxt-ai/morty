// The pinned previous release publishes its runtime declarations under a path
// that its export map does not name. The runtime API the controlled harness uses
// (configuration, engine and in-process Agent definitions) is unchanged since
// that release, so its declarations follow the current runtime.
declare module "@moxt-ai/mobius-previous/runtime" {
    export * from "@moxt-ai/mobius/runtime";
}
