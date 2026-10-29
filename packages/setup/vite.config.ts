import { builtinModules } from "node:module";
import { defineConfig } from "vite";

// A release build names the public source it came from, so whoever inspects the downloaded
// script can rebuild that revision and compare. Development builds carry no revision.
const revision = process.env["MORTY_SETUP_REVISION"];
if (revision !== undefined && !/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("MORTY_SETUP_REVISION must be a full commit SHA");
}

export default defineConfig({
    resolve: {
        mainFields: ["module", "main"],
    },
    build: {
        target: "node22",
        minify: false,
        lib: {
            entry: { setup: "src/cli.ts" },
            formats: ["es"],
            fileName: (_format, name) => `${name}.mjs`,
        },
        rolldownOptions: {
            external: [...builtinModules, /^node:/u],
            output: {
                ...(revision === undefined
                    ? {}
                    : {
                          banner: [
                              `// Morty setup, built from https://github.com/moxt-ai/morty/tree/${revision}/packages/setup`,
                              `// Rebuild this file there with: MORTY_SETUP_REVISION=${revision} pnpm build:setup`,
                          ].join("\n"),
                      }),
                codeSplitting: false,
                intro: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
            },
        },
    },
});
