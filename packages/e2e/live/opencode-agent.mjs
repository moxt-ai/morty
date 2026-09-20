import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executable, imageMcp, publishableKey } from "./config.mjs";

export async function prepareOpenCodeAgent(harness, repository, provider) {
    const binary = await executable("opencode", ["OPENCODE_BIN", "MOBIUS_OPENCODE_PATH"]);
    const clerkPublishableKey = await publishableKey(repository);
    const version = (await harness.run(binary, ["--version"])).stdout.trim();
    const xdgConfigHome = join(harness.workDirectory, "opencode-config");
    const configurationDirectory = join(xdgConfigHome, "opencode");
    await mkdir(configurationDirectory, { recursive: true });
    await writeFile(
        join(configurationDirectory, "opencode.json"),
        `${JSON.stringify(
            {
                model: `mobius/${provider.model}`,
                mcp: {
                    mobius_image: {
                        type: "local",
                        command: [process.execPath, imageMcp],
                        enabled: true,
                    },
                },
                permission: { "mobius_image_*": "allow" },
                provider: {
                    mobius: {
                        models: {
                            [provider.model]: { name: "Mobius image E2E model" },
                        },
                        name: "Mobius fake provider",
                        npm: "@ai-sdk/openai-compatible",
                        options: {
                            apiKey: provider.apiKey,
                            baseURL: `${provider.origin}/v1`,
                        },
                    },
                },
            },
            null,
            2,
        )}\n`,
        { mode: 0o600 },
    );
    harness.record("opencode", {
        version,
        model: provider.model,
        providerOrigin: provider.origin,
    });
    harness.record("clerkPublishableKeyConfigured", true);
    return {
        acpBinary: binary,
        description: `${provider.model} through local fake LLM provider on OpenCode ${version}`,
        id: "opencode",
        label: "OpenCode",
        publishableKey: clerkPublishableKey,
        runtimeEnvironment: {
            OPENCODE_DISABLE_AUTOUPDATE: "1",
            XDG_CONFIG_HOME: xdgConfigHome,
        },
        adapterOverrideVariable: "MOBIUS_OPENCODE_PATH",
    };
}
