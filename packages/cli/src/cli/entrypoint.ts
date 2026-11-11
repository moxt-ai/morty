#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { satisfies } from "semver";
import packageMetadata from "../../package.json" with { type: "json" };

// Morty never passes another product's Computer credentials or configuration to child processes.
for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith("MOBIUS_")) {
        delete process.env[key];
    }
}

// Check before loading the runtime graph, which may require newer Node APIs.
if (!satisfies(process.versions.node, packageMetadata.engines.node)) {
    process.stderr.write(
        `Morty requires Node.js ${packageMetadata.engines.node}; found ${process.versions.node} at ${process.execPath}. Update Node.js and rerun the Morty command.\n`,
    );
    process.exitCode = 1;
} else {
    const { runCLI } = await import("./index.ts");
    await runCLI(fileURLToPath(import.meta.url));
}
