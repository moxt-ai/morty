import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mergeCoverage } from "./coverage-report/merge.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const mergeOnly = process.argv.includes("--merge-only");
const suites = [
    ["web", "packages/web"],
    ["worker", "packages/worker"],
];
const cancellation = new AbortController();
const interrupt = () => cancellation.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
    if (!mergeOnly) {
        await rm(new URL("../coverage/", import.meta.url), { recursive: true, force: true });
    }
    let failed = false;
    for (const [, directory] of mergeOnly ? [] : suites) {
        const vitest = fileURLToPath(new URL("vitest.mjs", import.meta.resolve("vitest/package.json")));
        const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(20 * 60 * 1000)]);
        const status = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [vitest, "run", "--coverage"], {
                cwd: `${root}/${directory}`,
                stdio: "inherit",
                signal,
            });
            child.once("error", reject);
            child.once("exit", (code) => resolve(code));
        });
        failed ||= status !== 0;
    }
    const webShards = Number(process.argv.find((argument) => argument.startsWith("--web-shards="))?.split("=")[1] ?? 0);
    const reportNames =
        webShards > 0
            ? [...Array.from({ length: webShards }, (_, index) => `web-${index + 1}`), "worker"]
            : suites.map(([name]) => name);
    await mergeCoverage(reportNames, cancellation.signal);
    if (failed) {
        process.exitCode = 1;
    }
} finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
}
