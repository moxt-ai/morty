import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

async function executable(harness) {
    const configured = process.env.OPENCODE_BIN ?? process.env.MOBIUS_OPENCODE_PATH;
    if (configured !== undefined && configured.trim().length > 0) {
        const path = resolve(configured);
        await access(path, constants.X_OK);
        return path;
    }
    try {
        return (await harness.run("sh", ["-c", "command -v opencode"])).stdout.trim();
    } catch {
        throw new Error("OpenCode executable not found");
    }
}

async function publishableKey(repository) {
    const configured = process.env.MOBIUS_E2E_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY;
    if (configured !== undefined && /^pk_(?:test|live)_[A-Za-z0-9_-]+$/u.test(configured)) {
        return configured;
    }
    try {
        const contents = await readFile(join(repository, ".dev.vars"), "utf8");
        const value = contents
            .match(/^CLERK_PUBLISHABLE_KEY=(.+)$/mu)?.[1]
            ?.trim()
            .replace(/^['"]|['"]$/gu, "");
        if (value !== undefined && /^pk_(?:test|live)_[A-Za-z0-9_-]+$/u.test(value) && !value.includes("REPLACE")) {
            return value;
        }
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }
    throw new Error("Clerk publishable key not found");
}

export async function prepareOpenCode(harness, repository) {
    const binary = await executable(harness);
    const clerkPublishableKey = await publishableKey(repository);
    const { stdout: modelOutput } = await harness.run(binary, ["models", "opencode"]);
    const models = modelOutput
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => /^opencode\/[A-Za-z0-9._-]+$/u.test(line));
    const model = process.env.OPENCODE_E2E_MODEL ?? models.find((candidate) => candidate.endsWith("-free"));
    if (model === undefined || !models.includes(model)) {
        throw new Error(`No current OpenCode free model is available; found: ${models.join(", ") || "none"}`);
    }
    const version = (await harness.run(binary, ["--version"])).stdout.trim();
    const xdgConfigHome = join(harness.workDirectory, "opencode-config");
    const configurationDirectory = join(xdgConfigHome, "opencode");
    await mkdir(configurationDirectory, { recursive: true });
    await writeFile(join(configurationDirectory, "opencode.json"), `${JSON.stringify({ model }, null, 2)}\n`, {
        mode: 0o600,
    });
    harness.record("opencode", {
        version,
        model,
        freeModels: models.filter((candidate) => candidate.endsWith("-free")),
    });
    harness.record("clerkPublishableKeyConfigured", true);
    return { binary, model, publishableKey: clerkPublishableKey, xdgConfigHome };
}
