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
    const generatedImage = join(home, "generated_images", "mobius-e2e", "geometric.png");
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
            "[mcp_servers.mobius_image.env]",
            `MOBIUS_IMAGE_OUTPUT_PATH = ${JSON.stringify(generatedImage)}`,
            "",
        ].join("\n"),
        { mode: 0o600 },
    );
    const version = (await harness.run(binary, ["--version"])).stdout.trim();
    const acpVersion = (await harness.run(acpBinary, ["--version"])).stdout.trim();
    harness.record("codex", { version, acpVersion, model: provider.model, providerOrigin: provider.origin });
    harness.record("clerkPublishableKeyConfigured", true);
    const runtimeEnvironment = {
        CODEX_API_KEY: provider.apiKey,
        CODEX_HOME: home,
        CODEX_PATH: binary,
        DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }),
        HOME: harness.workDirectory,
        INITIAL_AGENT_MODE: "agent-full-access",
        MOBIUS_CODEX_PATH: binary,
    };
    return {
        acpBinary,
        adapterOverrideVariable: "MOBIUS_CODEX_ACP_PATH",
        description: `${version} through ${acpVersion} and local fake LLM provider`,
        id: "codex",
        label: "Codex",
        publishableKey: clerkPublishableKey,
        runtimeEnvironment,
        seedNativeSession: async (cwd) => {
            const result = await harness.run(
                "/bin/sh",
                [
                    "-c",
                    'exec "$@" </dev/null',
                    "mobius-codex-e2e",
                    binary,
                    "exec",
                    "--json",
                    "--disable",
                    "apps",
                    "--disable",
                    "plugins",
                    "--disable",
                    "remote_plugin",
                    "--dangerously-bypass-approvals-and-sandbox",
                    "--skip-git-repo-check",
                    "--cd",
                    cwd,
                    "Create an initial session for the Mobius end-to-end test.",
                ],
                { cwd, env: runtimeEnvironment, label: "codex exec (seed native session)" },
            );
            const started = result.stdout
                .split("\n")
                .filter((line) => line.trim().length > 0)
                .map((line) => JSON.parse(line))
                .find((event) => event.type === "thread.started");
            if (started === undefined || typeof started.thread_id !== "string") {
                throw new Error(`Codex did not report a native session ID: ${result.stdout}`);
            }
            return started.thread_id;
        },
    };
}
