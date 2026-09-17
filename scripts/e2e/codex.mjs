import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executable, imageMcp, publishableKey } from "./config.mjs";

export async function prepareCodex(harness, repository, provider) {
    const [binary, acpBinary, clerkPublishableKey] = await Promise.all([
        executable("codex", ["CODEX_BIN", "MOBIUS_CODEX_PATH"]),
        executable("codex-acp", ["CODEX_ACP_BIN", "MOBIUS_CODEX_ACP_PATH"]),
        publishableKey(repository),
    ]);
    const home = join(harness.workDirectory, "codex-home");
    await mkdir(home, { recursive: true });
    await writeFile(
        join(home, "config.toml"),
        [
            `model = ${JSON.stringify(provider.model)}`,
            `openai_base_url = ${JSON.stringify(`${provider.origin}/v1`)}`,
            'model_reasoning_effort = "low"',
            'model_reasoning_summary = "none"',
            "model_supports_reasoning_summaries = false",
            "",
            "[mcp_servers.mobius_image]",
            `command = ${JSON.stringify(process.execPath)}`,
            `args = [${JSON.stringify(imageMcp)}]`,
            "",
        ].join("\n"),
        { mode: 0o600 },
    );
    const version = (await harness.run(binary, ["--version"])).stdout.trim();
    const acpVersion = (await harness.run(acpBinary, ["--version"])).stdout.trim();
    harness.record("codex", { version, acpVersion, model: provider.model, providerOrigin: provider.origin });
    harness.record("clerkPublishableKeyConfigured", true);
    return {
        acpBinary,
        adapterOverrideVariable: "MOBIUS_CODEX_ACP_PATH",
        description: `${version} through ${acpVersion} and local fake LLM provider`,
        id: "codex",
        label: "Codex",
        publishableKey: clerkPublishableKey,
        runtimeEnvironment: {
            CODEX_API_KEY: provider.apiKey,
            CODEX_HOME: home,
            CODEX_PATH: binary,
            DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }),
            HOME: harness.workDirectory,
            INITIAL_AGENT_MODE: "agent-full-access",
            MOBIUS_CODEX_PATH: binary,
        },
    };
}
