import { builtinModules } from "node:module";
import { defineConfig } from "vite";

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
                codeSplitting: false,
                intro: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
            },
        },
    },
});
