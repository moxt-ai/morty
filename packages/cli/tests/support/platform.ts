import { MobiusAppCredentialProvider, MobiusPlatformAppClient } from "@morty-build/client/platform";
import { createTestMobiusPlatformBindings } from "@morty-build/platform-test-support/cloudflare";
import { seedMortyService } from "@morty-build/platform-test-support/service-fixture";
import type { FakeAgentHarnessDefinition } from "./agent-harness.ts";
import { createFakeAgentHarnessRuntime } from "./platform-agent-harness.ts";

/** Starts the production Platform boundary with isolated local Cloudflare storage. */
export async function startTestPlatform(options: { readonly allowedOrigins?: ReadonlySet<string> } = {}) {
    const cancellation = new AbortController();
    const runtimes: AsyncDisposable[] = [];
    const bindings = await createTestMobiusPlatformBindings(options.allowedOrigins);
    try {
        const app = { request: bindings.request };
        const application = await seedMortyService(bindings.env.PLATFORM_DIRECTORY_DATABASE);
        const credential = application.credential;
        const service = new MobiusPlatformAppClient({
            endpoint: bindings.origin,
            credentialProvider: new MobiusAppCredentialProvider(credential),
            transport: { fetch: bindings.request },
        });
        const close = async (): Promise<void> => {
            cancellation.abort(new Error("Test Platform stopped"));
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
                projectId: string,
                harnesses?: readonly FakeAgentHarnessDefinition[],
                nativeSessionIds?: ReadonlySet<string>,
            ) => {
                const runtime = await createFakeAgentHarnessRuntime({
                    credential,
                    ...(harnesses === undefined ? {} : { harnesses }),
                    ...(nativeSessionIds === undefined ? {} : { nativeSessionIds }),
                    origin: bindings.origin,
                    projectId,
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
