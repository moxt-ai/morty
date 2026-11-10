import { MortyAppCredentialProvider, MortyRelayAppClient } from "@morty-build/client/relay";
import { createTestMortyRelayBindings } from "@morty-build/relay-test-support/cloudflare";
import { seedMortyService } from "@morty-build/relay-test-support/service-fixture";
import type { FakeAgentHarnessDefinition } from "./agent-harness.ts";
import { createFakeAgentHarnessRuntime } from "./relay-agent-harness.ts";

/** Starts the production Relay boundary with isolated local Cloudflare storage. */
export async function startTestRelay(options: { readonly allowedOrigins?: ReadonlySet<string> } = {}) {
    const cancellation = new AbortController();
    const runtimes: AsyncDisposable[] = [];
    const bindings = await createTestMortyRelayBindings(options.allowedOrigins);
    try {
        const app = { request: bindings.request };
        const application = await seedMortyService(bindings.env.RELAY_DIRECTORY_DATABASE);
        const credential = application.credential;
        const service = new MortyRelayAppClient({
            endpoint: bindings.origin,
            credentialProvider: new MortyAppCredentialProvider(credential),
            transport: { fetch: bindings.request },
        });
        const close = async (): Promise<void> => {
            cancellation.abort(new Error("Test Relay stopped"));
            try {
                await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime[Symbol.asyncDispose]()));
            } finally {
                await bindings[Symbol.asyncDispose]();
            }
        };
        return {
            app,
            appId: application.appId,
            appCredential: credential,
            attachments: bindings.env.R2_BUCKET_APAC,
            baseUrl: bindings.origin,
            service,
            connectAgent: async (
                computerId: string,
                harnesses?: readonly FakeAgentHarnessDefinition[],
                sessionIds?: ReadonlySet<string>,
            ) => {
                const runtime = await createFakeAgentHarnessRuntime({
                    credential,
                    ...(harnesses === undefined ? {} : { harnesses }),
                    ...(sessionIds === undefined ? {} : { sessionIds }),
                    origin: bindings.origin,
                    computerId,
                    server: app,
                    signal: cancellation.signal,
                });
                runtimes.push(runtime);
                return runtime;
            },
            close,
            [Symbol.asyncDispose]: close,
        };
    } catch (cause) {
        cancellation.abort(cause);
        await bindings[Symbol.asyncDispose]();
        throw cause;
    }
}
