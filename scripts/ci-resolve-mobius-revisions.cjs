const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const before = process.env.BEFORE_SHA;
const eventName = process.env.EVENT_NAME;
const output = process.env.GITHUB_OUTPUT;
const manual = eventName === "workflow_dispatch";

if (output === undefined) {
    throw new Error("GitHub output path is unavailable");
}
if (!manual && (before === undefined || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(before))) {
    throw new Error("The previous commit SHA is invalid");
}

const resolveMobiusRevision = (revision) =>
    execFileSync("git", ["rev-parse", `${revision}:third-party/mobius`], {
        encoding: "utf8",
        timeout: 30_000,
    }).trim();

if (!manual) {
    appendFileSync(output, `previous=${resolveMobiusRevision(before)}\n`);
}
appendFileSync(output, `current=${resolveMobiusRevision("HEAD")}\n`);
