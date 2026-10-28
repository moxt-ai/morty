const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const { chmod, mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");

const execFileAsync = promisify(execFile);
const monitor = join(__dirname, "monitor-pr.cjs");

function check(databaseId, conclusion, name = "title") {
    return {
        __typename: "CheckRun",
        databaseId,
        name,
        status: conclusion === null ? "IN_PROGRESS" : "COMPLETED",
        conclusion,
        detailsUrl: "https://github.com/example/project/actions/runs/1",
        checkSuite: { workflowRun: { workflow: { name: "PR title" } } },
    };
}

function snapshot(checks, queueChecks) {
    const commit = (nodes) => ({
        oid: "1234567890abcdef",
        statusCheckRollup: {
            state: "FAILURE",
            contexts: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
        },
    });
    return {
        state: "OPEN",
        merged: false,
        mergedAt: null,
        isDraft: false,
        reviewDecision: null,
        headRefOid: "1234567890abcdef",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        autoMergeRequest: null,
        mergeCommit: null,
        mergeQueueEntry:
            queueChecks === undefined
                ? null
                : { state: "QUEUED", position: 1, estimatedTimeToMerge: null, headCommit: commit(queueChecks) },
        commits: { nodes: [{ commit: commit(checks) }] },
        timelineItems: { nodes: [] },
    };
}

async function withGitHub(pullRequest, run) {
    const directory = await mkdtemp(join(tmpdir(), "monitor-pr-replacement-"));
    const gh = join(directory, "gh");
    try {
        await writeFile(
            gh,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") process.exit(0);
if (args[0] === "pr" && args[1] === "view") {
    console.log(JSON.stringify({ number: 42, title: "Replacement checks", url: "https://github.com/example/project/pull/42", baseRefName: "main", headRefName: "feature" }));
} else if (args[0] === "api" && args[1] === "graphql") {
    console.log(JSON.stringify({ data: { repository: { pullRequest: ${JSON.stringify(pullRequest)} } } }));
} else {
    console.error("Unexpected gh arguments: " + args.join(" "));
    process.exit(2);
}
`,
        );
        await chmod(gh, 0o755);
        await run({ ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

const monitorArgs = [monitor, "--repo", "example/project", "--pr", "42"];

test("Given a cancelled check replaced by success and a historical FAILURE rollup, When monitoring, Then the PR is ready", async () => {
    await withGitHub(snapshot([check(1, "CANCELLED"), check(2, "SUCCESS")]), async (env) => {
        const result = await execFileAsync(process.execPath, monitorArgs, { env, timeout: 5_000 });
        assert.match(result.stdout, /PR CI: 1\/1 passed, 0 pending, 0 failed/);
        assert.match(result.stdout, /READY TO MERGE:/);
        assert.equal(result.stderr, "");
    });
});

test("Given a FAILURE rollup without check details, When monitoring, Then it fails conservatively", async () => {
    await withGitHub(snapshot([]), async (env) => {
        await assert.rejects(execFileAsync(process.execPath, monitorArgs, { env, timeout: 5_000 }), (error) => {
            assert.equal(error.code, 1);
            assert.match(error.stderr, /FAILED: PR head aggregate status is FAILURE/);
            return true;
        });
    });
});

for (const queued of [false, true]) {
    test(`Given a historical FAILURE rollup and ${queued ? "queued" : "PR"} replacement checks pending, When monitoring, Then it continues until cancelled`, async () => {
        const replacements = [check(2, null), check(1, "CANCELLED")];
        const pr = queued ? snapshot([check(2, "SUCCESS")], replacements) : snapshot(replacements);
        await withGitHub(pr, async (env) => {
            const child = spawn(process.execPath, monitorArgs, {
                env,
                stdio: ["ignore", "pipe", "pipe"],
                signal: AbortSignal.timeout(5_000),
            });
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (data) => {
                stdout += data;
                if (stdout.includes("Next check:")) {
                    child.kill("SIGTERM");
                }
            });
            child.stderr.on("data", (data) => {
                stderr += data;
            });
            try {
                const code = await new Promise((resolve, reject) => {
                    child.once("error", reject);
                    child.once("close", resolve);
                });
                assert.equal(code, 130, stderr);
                assert.match(stdout, /0\/1 passed, 1 pending, 0 failed/);
                assert.match(stdout, /Next check:/);
                assert.doesNotMatch(stdout, /READY TO MERGE:/);
                assert.equal(stderr.trim(), "Monitoring cancelled");
            } finally {
                child.kill("SIGKILL");
            }
        });
    });

    test(`Given a latest failed ${queued ? "queue" : "PR"} check, When monitoring, Then it still fails`, async () => {
        const checks = [check(1, "SUCCESS"), check(2, "FAILURE")];
        const pr = queued ? snapshot([check(2, "SUCCESS")], checks) : snapshot(checks);
        await withGitHub(pr, async (env) => {
            await assert.rejects(execFileAsync(process.execPath, monitorArgs, { env, timeout: 5_000 }), (error) => {
                assert.equal(error.code, 1);
                assert.match(error.stderr, /check title failed \(COMPLETED\/FAILURE/);
                return true;
            });
        });
    });
}

test("Given a pull request behind its base branch, When monitoring starts, Then it fails immediately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "monitor-pr-behind-"));
    const gh = join(directory, "gh");
    const fake = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") process.exit(0);
if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: 42,
    title: "Behind pull request",
    url: "https://github.com/example/project/pull/42",
    baseRefName: "main",
    headRefName: "feature"
  }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "graphql") {
  console.log(JSON.stringify({ data: { repository: { pullRequest: {
    state: "OPEN",
    merged: false,
    mergedAt: null,
    isDraft: false,
    reviewDecision: null,
    headRefOid: "1234567890abcdef",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BEHIND",
    autoMergeRequest: null,
    mergeCommit: null,
    mergeQueueEntry: null,
    commits: { nodes: [{ commit: {
      oid: "1234567890abcdef",
      statusCheckRollup: {
        state: "PENDING",
        contexts: {
          nodes: [{
            __typename: "CheckRun",
            databaseId: 1,
            name: "tests",
            status: "IN_PROGRESS",
            conclusion: null,
            detailsUrl: null,
            checkSuite: null
          }],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    } }] },
    timelineItems: { nodes: [] }
  } } } }));
  process.exit(0);
}
console.error("Unexpected gh arguments: " + args.join(" "));
process.exit(2);
`;

    try {
        await writeFile(gh, fake);
        await chmod(gh, 0o755);
        await assert.rejects(
            execFileAsync(process.execPath, [monitor, "--repo", "example/project", "--pr", "42"], {
                env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
                timeout: 1_000,
            }),
            (error) => {
                assert.equal(error.code, 1);
                assert.match(error.stderr, /FAILED: Pull request branch is behind the base branch/);
                return true;
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
