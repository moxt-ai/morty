import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";

const repository = "moxt-ai/mobius-morty";
const runId = process.env.ARCHIVE_RUN_ID;
if (!/^\d+$/.test(runId ?? "")) {
    throw new Error("A numeric successful archive run is required");
}
const api = (path) =>
    JSON.parse(execFileSync("gh", ["api", `repos/${repository}/${path}`], { encoding: "utf8", timeout: 60000 }));
const authorized = (run) =>
    run.conclusion === "success" &&
    run.head_branch === "main" &&
    run.head_repository?.full_name === repository &&
    ["push", "workflow_dispatch"].includes(run.event);
const completed = (run, names) => {
    const result = api(`actions/runs/${run.id}/jobs?per_page=100`);
    if (result.total_count > result.jobs.length) {
        throw new Error("Incomplete job inventory");
    }
    return names.every((name) => result.jobs.some((job) => job.name === name && job.conclusion === "success"));
};
const run = api(`actions/runs/${runId}`);
if (!authorized(run)) {
    throw new Error("Archive run is not an authorized successful main run");
}
let cliRun = run;
let legacy = false;
if (run.path === ".github/workflows/morty-cli.yml") {
    if (!completed(run, ["publish", "deploy", "github-release"])) {
        throw new Error("Recovery requires the completed release chain");
    }
} else if (run.path === ".github/workflows/morty-cloud.yml") {
    // Legacy releases archived cloud and CLI bytes in independent runs.
    // Accept them only with successful publication of the same source revision.
    const result = api(`actions/workflows/morty-cli.yml/runs?head_sha=${run.head_sha}&status=success&per_page=100`);
    if (result.total_count > result.workflow_runs.length) {
        throw new Error("Incomplete legacy release inventory");
    }
    cliRun = result.workflow_runs.find(
        (candidate) =>
            authorized(candidate) && candidate.head_sha === run.head_sha && completed(candidate, ["publish"]),
    );
    if (!cliRun) {
        throw new Error("No successful CLI publication for this archived source");
    }
    legacy = true;
} else {
    throw new Error("Unrecognized release workflow");
}
for (const [source, name] of legacy
    ? [
          [run, "release-production"],
          [cliRun, "morty-cli"],
      ]
    : [[run, "morty-release"]]) {
    const inventory = api(`actions/runs/${source.id}/artifacts?per_page=100`);
    if (inventory.total_count > inventory.artifacts.length) {
        throw new Error("Incomplete archive inventory");
    }
    const matching = inventory.artifacts.filter((artifact) => artifact.name === name && !artifact.expired);
    if (matching.length !== 1) {
        throw new Error("The original accepted archive is missing, expired or ambiguous");
    }
}
await appendFile(process.env.GITHUB_OUTPUT, `revision=${run.head_sha}\nlegacy=${legacy}\ncli_run=${cliRun.id}\n`);
