#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const { resolve } = require("node:path");

const repositoryRoot = resolve(__dirname, "..");
const timeout = 120_000;

const runGit = (args) => {
    execFileSync("git", args, {
        cwd: repositoryRoot,
        stdio: "inherit",
        timeout,
    });
};

try {
    runGit(["submodule", "sync", "--recursive"]);
    runGit(["submodule", "update", "--init", "--remote", "--checkout", "--recursive"]);
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to sync submodules: ${message}`);
    process.exitCode = 1;
}
