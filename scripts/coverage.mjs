import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mergeCoverage } from "./coverage-merge.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const suites = [
    ["web", "packages/web"],
    ["worker", "packages/worker"],
];
const cancellation = new AbortController();
const interrupt = () => cancellation.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
    await rm(new URL("../coverage/", import.meta.url), { recursive: true, force: true });
    let failed = false;
    for (const [, directory] of suites) {
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
    await mergeCoverage(
        suites.map(([name]) => name),
        cancellation.signal,
    );
    if (failed) {
        process.exitCode = 1;
    }
} finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
}
