#!/usr/bin/env node

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const DEFAULT_INTERVAL_SECONDS = 10;
const MINIMUM_INTERVAL_SECONDS = 10;
const MAX_FAILED_SAMPLES = 3;

class MonitorFailure extends Error {}

const SNAPSHOT_QUERY = `
query MonitorPullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      url
      state
      merged
      mergedAt
      isDraft
      reviewDecision
      headRefName
      headRefOid
      baseRefName
      mergeable
      mergeStateStatus
      autoMergeRequest { enabledAt }
      mergeCommit { oid }
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              state
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    databaseId
                    name
                    status
                    conclusion
                    detailsUrl
                    checkSuite { workflowRun { workflow { name } } }
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      }
      mergeQueueEntry {
        state
        position
        enqueuedAt
        estimatedTimeToMerge
        headCommit {
          oid
          statusCheckRollup {
            state
            contexts(first: 100) {
              nodes {
                __typename
                ... on CheckRun {
                  databaseId
                  name
                  status
                  conclusion
                  detailsUrl
                  checkSuite { workflowRun { workflow { name } } }
                }
                ... on StatusContext {
                  context
                  state
                  targetUrl
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
      timelineItems(last: 20, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes {
          ... on RemovedFromMergeQueueEvent {
            createdAt
            reason
            beforeCommit { oid }
          }
        }
      }
    }
  }
}`;

const CONTEXTS_QUERY = `
query MonitorCommitContexts($owner: String!, $name: String!, $oid: GitObjectID!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: 100, after: $cursor) {
            nodes {
              __typename
              ... on CheckRun {
                databaseId
                name
                status
                conclusion
                detailsUrl
                checkSuite { workflowRun { workflow { name } } }
              }
              ... on StatusContext {
                context
                state
                targetUrl
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
}`;

function usage() {
    return `Usage: monitor-pr.cjs [--repo OWNER/REPO] [--pr NUMBER|URL] [--interval SECONDS]

Monitor an open pull request until it is ready to merge, or a queued pull request until it merges.
The default and minimum reporting interval is 10 seconds.`;
}

function parseArguments(argv) {
    const values = { repo: undefined, selector: undefined, intervalSeconds: DEFAULT_INTERVAL_SECONDS };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--help" || argument === "-h") {
            return { kind: "help" };
        }
        if (argument === "--repo" || argument === "--pr" || argument === "--interval") {
            const value = argv[index + 1];
            if (value === undefined) {
                throw new Error(`Missing value for ${argument}`);
            }
            index += 1;
            if (argument === "--repo") {
                values.repo = value;
            }
            if (argument === "--pr") {
                values.selector = value;
            }
            if (argument === "--interval") {
                values.intervalSeconds = Number(value);
            }
            continue;
        }
        if (argument.startsWith("-")) {
            throw new Error(`Unknown option: ${argument}`);
        }
        if (values.selector !== undefined) {
            throw new Error("Specify only one pull request");
        }
        values.selector = argument;
    }

    if (!Number.isSafeInteger(values.intervalSeconds) || values.intervalSeconds < MINIMUM_INTERVAL_SECONDS) {
        throw new Error(`Interval must be an integer of at least ${MINIMUM_INTERVAL_SECONDS} seconds`);
    }
    if (values.repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repo)) {
        throw new Error("Repository must have the form OWNER/REPO");
    }

    return { kind: "monitor", ...values };
}

function parsePullRequestUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        return undefined;
    }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.search || url.hash) {
        throw new Error("Pull request URLs must be canonical HTTPS github.com URLs");
    }
    const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/);
    if (match === null) {
        throw new Error("Pull request URL must have the form https://github.com/OWNER/REPO/pull/NUMBER");
    }
    return { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

function normalizeTargetArguments(options) {
    if (options.selector === undefined) {
        return options;
    }
    const fromUrl = parsePullRequestUrl(options.selector);
    if (fromUrl !== undefined) {
        if (options.repo !== undefined && options.repo.toLowerCase() !== fromUrl.repo.toLowerCase()) {
            throw new Error("The --repo value does not match the pull request URL");
        }
        return { ...options, repo: fromUrl.repo, selector: String(fromUrl.number) };
    }
    if (!/^[1-9][0-9]*$/.test(options.selector)) {
        throw new Error("Pull request must be a positive number or canonical GitHub URL");
    }
    return options;
}

async function runGh(args, context) {
    const timeoutMilliseconds = context.intervalSeconds * 1_000;
    try {
        const result = await execFileAsync("gh", args, {
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
            timeout: timeoutMilliseconds,
            signal: context.signal,
            env: { ...process.env, GH_HTTP_TIMEOUT: String(context.intervalSeconds) },
        });
        return result.stdout;
    } catch (error) {
        if (context.signal.aborted || error.name === "AbortError") {
            throw error;
        }
        const detail = String(error.stderr || error.message || error).trim();
        throw new Error(detail || `gh ${args[0]} failed`, { cause: error });
    }
}

async function readJson(args, context) {
    const output = await runGh(args, context);
    try {
        return JSON.parse(output);
    } catch (error) {
        throw new Error("GitHub CLI returned invalid JSON", { cause: error });
    }
}

async function resolveTarget(options, context) {
    await runGh(["auth", "status"], context);
    let repo = options.repo;
    if (repo === undefined) {
        const current = await readJson(["repo", "view", "--json", "nameWithOwner"], context);
        repo = current.nameWithOwner;
    }

    const viewArgs = ["pr", "view"];
    if (options.selector !== undefined) {
        viewArgs.push(options.selector);
    }
    viewArgs.push("--repo", repo, "--json", "number,title,url,baseRefName,headRefName");
    const pullRequest = await readJson(viewArgs, context);
    const canonical = parsePullRequestUrl(pullRequest.url);
    if (canonical === undefined || canonical.repo.toLowerCase() !== repo.toLowerCase()) {
        throw new Error("GitHub resolved the pull request to an unexpected repository");
    }

    const [owner, name] = canonical.repo.split("/");
    return { owner, name, repo: canonical.repo, number: pullRequest.number, ...pullRequest };
}

async function graphql(query, variables, context) {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [name, value] of Object.entries(variables)) {
        args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
    }
    const response = await readJson(args, context);
    if (Array.isArray(response.errors) && response.errors.length > 0) {
        throw new Error(response.errors.map((error) => error.message).join("; "));
    }
    return response.data;
}

async function completeContexts(owner, name, commit, context) {
    const rollup = commit?.statusCheckRollup;
    if (rollup === null || rollup === undefined) {
        return [];
    }
    const contexts = [...rollup.contexts.nodes];
    let pageInfo = rollup.contexts.pageInfo;
    while (pageInfo.hasNextPage) {
        const data = await graphql(
            CONTEXTS_QUERY,
            { owner, name, oid: commit.oid, cursor: pageInfo.endCursor },
            context,
        );
        const page = data.repository.object.statusCheckRollup.contexts;
        contexts.push(...page.nodes);
        pageInfo = page.pageInfo;
    }
    return contexts;
}

async function readSnapshot(target, context) {
    const data = await graphql(
        SNAPSHOT_QUERY,
        { owner: target.owner, name: target.name, number: target.number },
        context,
    );
    const pullRequest = data.repository?.pullRequest;
    if (pullRequest === null || pullRequest === undefined) {
        throw new Error("Pull request no longer exists or is no longer accessible");
    }
    const pullRequestCommit = pullRequest.commits.nodes[0]?.commit;
    const queueCommit = pullRequest.mergeQueueEntry?.headCommit;
    return {
        pullRequest,
        pullRequestCommit,
        pullRequestContexts: await completeContexts(target.owner, target.name, pullRequestCommit, context),
        queueCommit,
        queueContexts: await completeContexts(target.owner, target.name, queueCommit, context),
    };
}

const FAILURE_CONCLUSIONS = new Set([
    "FAILURE",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
]);
const PASS_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function describeContext(item) {
    if (item.__typename === "CheckRun") {
        return {
            name: item.name,
            workflow: item.checkSuite?.workflowRun?.workflow?.name,
            state: item.status,
            conclusion: item.conclusion,
            url: item.detailsUrl,
            category: FAILURE_CONCLUSIONS.has(item.conclusion)
                ? "failed"
                : item.status === "COMPLETED" && PASS_CONCLUSIONS.has(item.conclusion)
                  ? "passed"
                  : "pending",
        };
    }
    return {
        name: item.context,
        workflow: undefined,
        state: item.state,
        conclusion: item.state,
        url: item.targetUrl,
        category:
            item.state === "ERROR" || item.state === "FAILURE"
                ? "failed"
                : item.state === "SUCCESS"
                  ? "passed"
                  : "pending",
    };
}

function latestContexts(contexts) {
    const latest = new Map();
    for (const item of contexts) {
        const workflow = item.__typename === "CheckRun" ? item.checkSuite?.workflowRun?.workflow?.name || "" : "";
        const name = item.__typename === "CheckRun" ? item.name : item.context;
        const key = `${item.__typename}:${workflow}:${name}`;
        const current = latest.get(key);
        if (
            current === undefined ||
            (item.__typename === "CheckRun" &&
                current.__typename === "CheckRun" &&
                (item.databaseId ?? 0) > (current.databaseId ?? 0))
        ) {
            latest.set(key, item);
        }
    }
    return [...latest.values()];
}

function summarize(commit, contexts) {
    if (commit?.statusCheckRollup === null || commit?.statusCheckRollup === undefined) {
        return { unknown: true, passed: 0, pending: 0, failed: 0, total: 0, items: [] };
    }
    const items = latestContexts(contexts).map(describeContext);
    return {
        unknown: false,
        passed: items.filter((item) => item.category === "passed").length,
        pending: items.filter((item) => item.category === "pending").length,
        failed: items.filter((item) => item.category === "failed").length,
        total: items.length,
        aggregate: commit.statusCheckRollup.state,
        items,
    };
}

function shortSha(oid) {
    return oid === null || oid === undefined ? "unknown" : oid.slice(0, 8);
}

function summaryText(summary) {
    if (summary.unknown) {
        return "unknown (no status rollup)";
    }
    return `${summary.passed}/${summary.total} passed, ${summary.pending} pending, ${summary.failed} failed`;
}

function itemNames(summary, category) {
    return summary.items.filter((item) => item.category === category).map((item) => item.name);
}

function reportSnapshot(target, snapshot) {
    const pr = snapshot.pullRequest;
    const prSummary = summarize(snapshot.pullRequestCommit, snapshot.pullRequestContexts);
    const queueSummary = summarize(snapshot.queueCommit, snapshot.queueContexts);
    const queue = pr.mergeQueueEntry;
    const phase =
        queue !== null ? "IN MERGE QUEUE" : pr.autoMergeRequest !== null ? "WAITING FOR MERGE QUEUE" : pr.state;
    console.log(`[${new Date().toISOString()}] ${target.repo}#${target.number} — ${phase}`);
    console.log(`PR CI: ${summaryText(prSummary)} (head ${shortSha(pr.headRefOid)})`);
    const pending = itemNames(prSummary, "pending");
    const failed = itemNames(prSummary, "failed");
    if (pending.length > 0) {
        console.log(`Pending: ${pending.join(", ")}`);
    }
    if (failed.length > 0) {
        console.log(`Failed: ${failed.join(", ")}`);
    }
    console.log(
        `Merge readiness: ${pr.mergeable}/${pr.mergeStateStatus}; review ${pr.reviewDecision || "unknown"}; auto-merge ${pr.autoMergeRequest === null ? "off" : "on"}`,
    );
    if (queue === null) {
        console.log("Queue: not entered");
    } else {
        console.log(
            `Queue: ${queue.state}, position ${queue.position ?? "unknown"}, ETA ${queue.estimatedTimeToMerge ?? "unknown"} [queue head ${shortSha(snapshot.queueCommit?.oid)}; ${summaryText(queueSummary)}]`,
        );
        const queuePending = itemNames(queueSummary, "pending");
        const queueFailed = itemNames(queueSummary, "failed");
        if (queuePending.length > 0) {
            console.log(`Queue pending: ${queuePending.join(", ")}`);
        }
        if (queueFailed.length > 0) {
            console.log(`Queue failed: ${queueFailed.join(", ")}`);
        }
    }
    return { prSummary, queueSummary };
}

function terminalCheck(summary, location) {
    const item = summary.items.find((candidate) => candidate.category === "failed");
    if (item !== undefined) {
        const workflow = item.workflow === undefined ? "" : `; workflow ${item.workflow}`;
        const url = item.url === null || item.url === undefined ? "" : `; ${item.url}`;
        return `${location} check ${item.name} failed (${item.state}/${item.conclusion}${workflow}${url})`;
    }
    if (summary.aggregate === "ERROR" || summary.aggregate === "FAILURE") {
        return `${location} aggregate status is ${summary.aggregate}`;
    }
    return undefined;
}

function latestRemoval(pr) {
    const removals = pr.timelineItems.nodes.filter((item) => item?.createdAt !== undefined);
    return removals.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function evaluate(target, snapshot, summaries, state) {
    const pr = snapshot.pullRequest;
    if (pr.merged || pr.mergedAt !== null) {
        return {
            kind: "merged",
            message: `${target.repo}#${target.number} merged at ${pr.mergedAt ?? "unknown"} (commit ${pr.mergeCommit?.oid ?? "unknown"})`,
        };
    }
    if (pr.state === "CLOSED") {
        return { kind: "failed", message: "Pull request closed without merging" };
    }
    const prCheck = terminalCheck(summaries.prSummary, "PR head");
    if (prCheck !== undefined) {
        return { kind: "failed", message: prCheck };
    }
    const queueCheck = terminalCheck(summaries.queueSummary, "Merge-queue head");
    if (queueCheck !== undefined) {
        return { kind: "failed", message: queueCheck };
    }
    if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
        return { kind: "failed", message: "Pull request has merge conflicts" };
    }
    if (pr.mergeQueueEntry?.state === "UNMERGEABLE") {
        return { kind: "failed", message: "Merge-queue entry is unmergeable" };
    }
    if (state.observedQueue && pr.mergeQueueEntry === null) {
        const removal = latestRemoval(pr);
        const detail =
            removal === undefined
                ? "no removal reason was available"
                : `${removal.reason || "unknown reason"} at ${removal.createdAt}`;
        return { kind: "failed", message: `Merge-queue entry disappeared before merge: ${detail}` };
    }
    if (state.observedQueue && state.headOid !== undefined && state.headOid !== pr.headRefOid) {
        return {
            kind: "failed",
            message: `PR head changed after queueing (${shortSha(state.headOid)} -> ${shortSha(pr.headRefOid)})`,
        };
    }
    if (
        pr.mergeQueueEntry === null &&
        pr.autoMergeRequest === null &&
        !pr.isDraft &&
        !summaries.prSummary.unknown &&
        summaries.prSummary.pending === 0 &&
        summaries.prSummary.failed === 0 &&
        pr.mergeable === "MERGEABLE" &&
        (pr.mergeStateStatus === "CLEAN" || pr.mergeStateStatus === "BEHIND")
    ) {
        return {
            kind: "ready",
            message: `${target.repo}#${target.number} is ready to merge (${summaries.prSummary.passed}/${summaries.prSummary.total} checks passed; head ${shortSha(pr.headRefOid)})`,
        };
    }
    return { kind: "continue" };
}

function isTerminalApiError(error) {
    return /authentication|authorization|HTTP 40[13]|Resource not accessible|Could not resolve|doesn't exist on type|Unknown argument|not a git repository/i.test(
        error.message,
    );
}

function wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        const aborted = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", aborted);
            resolve();
        }, milliseconds);
        signal.addEventListener("abort", aborted, { once: true });
    });
}

async function monitor(options, context) {
    const target = await resolveTarget(options, context);
    console.log(
        `Monitoring ${target.repo}#${target.number}: ${target.title}\n${target.headRefName} -> ${target.baseRefName}\n${target.url}`,
    );

    const state = { observedQueue: false, headOid: undefined, consecutiveFailures: 0 };
    for (;;) {
        try {
            const snapshot = await readSnapshot(target, context);
            state.consecutiveFailures = 0;
            const summaries = reportSnapshot(target, snapshot);
            const result = evaluate(target, snapshot, summaries, state);
            if (result.kind === "merged") {
                console.log(`MERGED: ${result.message}`);
                return;
            }
            if (result.kind === "ready") {
                console.log(`READY TO MERGE: ${result.message}`);
                return;
            }
            if (result.kind === "failed") {
                throw new MonitorFailure(result.message);
            }
            if (snapshot.pullRequest.mergeQueueEntry !== null) {
                state.observedQueue = true;
            }
            state.headOid = snapshot.pullRequest.headRefOid;
            console.log(
                snapshot.pullRequest.mergeQueueEntry !== null
                    ? `Next check: ${options.intervalSeconds}s, unless merged or failed`
                    : snapshot.pullRequest.autoMergeRequest !== null
                      ? `Next check: ${options.intervalSeconds}s, until queued, merged, or failed`
                      : `Next check: ${options.intervalSeconds}s, unless ready to merge, queued, or failed`,
            );
        } catch (error) {
            if (context.signal.aborted || error.name === "AbortError") {
                throw error;
            }
            if (isTerminalApiError(error)) {
                throw error;
            }
            if (error instanceof MonitorFailure) {
                throw error;
            }
            state.consecutiveFailures += 1;
            console.error(
                `[${new Date().toISOString()}] GitHub sample failed (${state.consecutiveFailures}/${MAX_FAILED_SAMPLES}): ${error.message}`,
            );
            if (state.consecutiveFailures >= MAX_FAILED_SAMPLES) {
                throw new Error(`Monitoring stopped after ${MAX_FAILED_SAMPLES} consecutive failed samples`, {
                    cause: error,
                });
            }
        }
        await wait(options.intervalSeconds * 1_000, context.signal);
    }
}

async function main() {
    let options;
    try {
        options = parseArguments(process.argv.slice(2));
        if (options.kind === "help") {
            console.log(usage());
            return;
        }
        options = normalizeTargetArguments(options);
    } catch (error) {
        console.error(`${error.message}\n\n${usage()}`);
        process.exitCode = 2;
        return;
    }

    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("Monitoring cancelled"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
        await monitor(options, { intervalSeconds: options.intervalSeconds, signal: controller.signal });
    } catch (error) {
        if (controller.signal.aborted) {
            console.error("Monitoring cancelled");
            process.exitCode = 130;
        } else {
            console.error(`FAILED: ${error.message}`);
            process.exitCode = 1;
        }
    } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
    }
}

void main();
