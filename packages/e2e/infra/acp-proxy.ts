#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const binary = process.env.MOBIUS_E2E_ACP_REAL_BIN;
const directory = process.env.MOBIUS_E2E_ACP_TRACE_DIRECTORY;
if (binary === undefined || directory === undefined) {
    throw new Error("ACP trace proxy is not configured");
}

await mkdir(directory, { recursive: true });
const prefix = join(directory, `${Date.now()}-${process.pid}`);
await writeFile(`${prefix}.json`, `${JSON.stringify({ args: process.argv.slice(2) }, null, 2)}\n`);

const input = createWriteStream(`${prefix}.stdin`);
const output = createWriteStream(`${prefix}.stdout`);
const errors = createWriteStream(`${prefix}.stderr`);
const child = spawn(binary, process.argv.slice(2), { env: process.env, stdio: ["pipe", "pipe", "pipe"] });

let suppressLiveResponse = false;
const requests = createInterface({ input: process.stdin });
requests.on("line", (line) => {
    if (line.includes('"method":"session/prompt"') && line.includes("recover completed native history")) {
        suppressLiveResponse = true;
    }
});
process.stdin.pipe(input);
process.stdin.pipe(child.stdin);
child.stdout.pipe(output);
const stdout = createInterface({ input: child.stdout });
stdout.on("line", (line) => {
    const dropsCompletedHistoryChunk = suppressLiveResponse && line.includes('"sessionUpdate":"agent_message_chunk"');
    if (!dropsCompletedHistoryChunk) {
        process.stdout.write(`${line}\n`);
    }
    if (line.includes('"stopReason":')) {
        suppressLiveResponse = false;
    }
});
child.stderr.pipe(errors);
child.stderr.pipe(process.stderr);
const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
for (const signal of signals) {
    process.on(signal, () => child.kill(signal));
}

const result = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
    },
);
input.end();
requests.close();
stdout.close();
output.end();
errors.end();
if (result.signal !== null) {
    process.kill(process.pid, result.signal);
}
process.exitCode = result.code ?? 1;
