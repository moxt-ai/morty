import { MortyAppCredentialProvider, MortyPlatformAppClient } from "@morty-build/client/platform";
import { createTestMortyPlatformBindings } from "@morty-build/platform-test-support/cloudflare";
import { seedMortyService } from "@morty-build/platform-test-support/service-fixture";
import { type ControlledAgent, createControlledAgentRuntime } from "../../../../tests/support/fake-daemon/runtime.ts";
import { mortyFiles, mortyReply } from "../../../../tests/support/fake-daemon/scenarios.ts";

/** Starts the production Platform boundary with isolated local Cloudflare storage. */
export async function startTestPlatform(
    options: { readonly allowedOrigins?: ReadonlySet<string> } = {},
    createBindings: typeof createTestMortyPlatformBindings = createTestMortyPlatformBindings,
) {
    const cancellation = new AbortController();
    const runtimes: AsyncDisposable[] = [];
    const bindings = await createBindings(options.allowedOrigins);
    try {
        const app = { request: bindings.request };
        const application = await seedMortyService(bindings.env.PLATFORM_DIRECTORY_DATABASE);
        const credential = application.credential;
        const service = new MortyPlatformAppClient({
            endpoint: bindings.origin,
            credentialProvider: new MortyAppCredentialProvider(credential),
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
                computerId: string,
                agents: readonly ControlledAgent[] = [{ id: "codex", label: "Codex" }],
                sessionIds?: ReadonlySet<string>,
            ) => {
                const runtime = await createControlledAgentRuntime({
                    credential,
                    behavior: {
                        reply: agents[0]?.reply ?? mortyReply,
                        files: mortyFiles,
                        agentId: agents[0]?.id ?? "codex",
                        agentName: agents[0]?.label ?? "Codex",
                        echoUserMessage: true,
                        additionalAgents: agents.slice(1).map((agent) => ({ id: agent.id, name: agent.label })),
                        beforeSessionCreated: agents[0]?.beforeSessionCreated,
                        beforeCancellationApplied: agents[0]?.beforeCancellationApplied,
                        onBackgroundPermissionReady: agents[0]?.onBackgroundPermissionReady,
                        ...(agents[0]?.beforeConfigurationApplied === undefined
                            ? {}
                            : { beforeConfigurationApplied: agents[0].beforeConfigurationApplied }),
                        ...(sessionIds === undefined ? {} : { sessionIds }),
                    },
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
