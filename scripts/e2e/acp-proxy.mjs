#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const binary = process.env.MOBIUS_E2E_OPENCODE_REAL_BIN;
const directory = process.env.MOBIUS_E2E_ACP_TRACE_DIRECTORY;
if (binary === undefined || directory === undefined) {
    throw new Error("OpenCode ACP proxy is not configured");
}

await mkdir(directory, { recursive: true });
const prefix = join(directory, `${Date.now()}-${process.pid}`);
await writeFile(`${prefix}.json`, `${JSON.stringify({ args: process.argv.slice(2) }, null, 2)}\n`);

const input = createWriteStream(`${prefix}.stdin`);
const output = createWriteStream(`${prefix}.stdout`);
const errors = createWriteStream(`${prefix}.stderr`);
const child = spawn(binary, process.argv.slice(2), { env: process.env, stdio: ["pipe", "pipe", "pipe"] });

process.stdin.pipe(input);
process.stdin.pipe(child.stdin);
child.stdout.pipe(output);
child.stdout.pipe(process.stdout);
child.stderr.pipe(errors);
child.stderr.pipe(process.stderr);
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
}

const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
});
input.end();
output.end();
errors.end();
if (result.signal !== null) {
    process.kill(process.pid, result.signal);
}
process.exitCode = result.code ?? 1;
