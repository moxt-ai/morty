import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const imageMcp = fileURLToPath(new URL("../../packages/e2e/fixtures/image-mcp.mjs", import.meta.url));

export async function executable(name, environmentVariables) {
    for (const variable of environmentVariables) {
        const configured = process.env[variable];
        if (configured !== undefined && configured.trim().length > 0) {
            const path = resolve(configured);
            await access(path, constants.X_OK);
            return path;
        }
    }
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
        if (directory.length === 0) {
            continue;
        }
        const path = join(directory, name);
        try {
            await access(path, constants.X_OK);
            return path;
        } catch {
            // Continue searching PATH.
        }
    }
    throw new Error(`${name} executable not found`);
}

export async function publishableKey(repository) {
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
