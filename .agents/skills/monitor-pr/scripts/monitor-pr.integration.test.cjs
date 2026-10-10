const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { chmod, mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");

const execFileAsync = promisify(execFile);
const monitor = join(__dirname, "monitor-pr.cjs");

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
