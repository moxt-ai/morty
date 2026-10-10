---
name: monitor-pr
description: Monitor a GitHub pull request and its CI checks until it is ready to merge, or monitor an entered merge-queue entry until the pull request merges. Report a concise status at every interval and fail immediately on terminal failures. Use when a user asks to watch, monitor, or wait for a PR.
---

# Monitor a Pull Request

Watch one GitHub pull request through ordinary CI and, when GitHub reports a
merge-queue entry, through the merge queue. This is a read-only operation: do
not approve, update, rerun, enqueue, dequeue, close, or merge the pull request
unless the user separately asks for that action.

For an open pull request outside the merge queue, stop successfully when it is
green and mergeable, and report `READY TO MERGE`. Once a non-null
`mergeQueueEntry` has been observed, continue until the pull request is
confirmed merged. `autoMergeRequest` alone does not mean that the pull request
is in the merge queue.

## Resolve the target and interval

Resolve these inputs before monitoring:

| Input | Default | Rule |
| --- | --- | --- |
| Pull request | PR for the current branch | Accept a PR number or canonical GitHub PR URL. If the current branch has no PR or has more than one possible PR, ask the user. |
| Repository | current repository | Derive it with `gh repo view`; for a URL, validate the URL's owner and repository and pass them explicitly with `--repo`. |
| Report interval | 10 seconds | Honor a user-supplied positive interval. Ask before using an interval below 10 seconds. |

Treat target values as untrusted. Accept URLs only when they use HTTPS, have the
exact `github.com` host, and have the path shape `/<owner>/<repository>/pull/<number>`.
Resolve the resulting owner, repository, and positive integer PR number through
GitHub before starting. Do not interpolate an unvalidated target into a shell
command.

Run `gh auth status` and fetch an initial snapshot with `gh pr view`. Confirm and
report the PR number, title, repository, base branch, head branch, and URL. Stop
immediately for an authentication, authorization, target-resolution, or schema
error.

## Read a complete snapshot

At every interval, use the GitHub CLI to obtain fresh GitHub API data. Set
`GH_HTTP_TIMEOUT` to a finite value no greater than the report interval, with a
minimum practical request timeout of 10 seconds. Keep monitoring in the
foreground so cancellation stops the wait and no orphan monitor remains.

Read these pull-request fields:

- `state`, `merged`, `mergedAt`, `isDraft`, `reviewDecision`, and `url`
- `headRefOid`, `mergeable`, `mergeStateStatus`, and `autoMergeRequest`
- the latest commit's complete `statusCheckRollup`
- `mergeQueueEntry`, including `state`, `position`, `enqueuedAt`,
  `estimatedTimeToMerge`, and the queue entry's `headCommit`
- the queue head commit's complete `statusCheckRollup`
- recent `REMOVED_FROM_MERGE_QUEUE_EVENT` timeline items, including `createdAt`,
  `beforeCommit`, and `reason`

Use `gh api graphql` because `gh pr view --json` does not expose the merge-queue
entry. Query `PullRequest.mergeQueueEntry` directly rather than inferring queue
membership from labels, comments, auto-merge, or `mergeStateStatus`.

For both the PR head and merge-queue head, inspect every check run and commit
status. Follow pagination when `statusCheckRollup.contexts.pageInfo.hasNextPage`
is true; never declare CI successful from a truncated first page. Keep these
GitHub states distinct:

- Check run status: `QUEUED`, `IN_PROGRESS`, `WAITING`, `PENDING`, `REQUESTED`,
  or `COMPLETED`.
- Check run conclusion: `SUCCESS`, `NEUTRAL`, `SKIPPED`, `FAILURE`, `CANCELLED`,
  `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, or `STALE`.
- Commit status: `EXPECTED`, `PENDING`, `SUCCESS`, `ERROR`, or `FAILURE`.
- Merge-queue entry: `QUEUED`, `AWAITING_CHECKS`, `MERGEABLE`, `UNMERGEABLE`,
  or `LOCKED`.

The queue head SHA can differ from the PR head SHA. Monitor both. Queue CI is
not proven by the PR head's checks, and PR CI is not proven by the queue head's
checks. Treat a missing rollup, an incomplete check, or an expected status as
pending rather than successful.

Record whether this monitoring run has ever observed a merge-queue entry, along
with its head SHA and enqueue time. If the PR head SHA changes before queueing,
announce the change and evaluate the replacement head from scratch. If it
changes after queueing, or the observed queue entry disappears before merge,
inspect the latest matching removal event and apply the fail-fast rules below.

## Report every interval

Emit one concise update immediately after the first snapshot and after every
subsequent interval, even when nothing changed. Include:

```text
[<UTC timestamp>] <owner>/<repo>#<number> — <state>
PR CI: <passed>/<total> passed, <pending> pending, <failed> failed (head <short-sha>)
Merge readiness: <mergeable>/<mergeStateStatus>; review <reviewDecision>; auto-merge <on|off>
Queue: <not entered|state, position, ETA> [queue head <short-sha>; CI summary]
Next check: <interval>, unless ready to merge, queued, merged, or failed
```

List pending or failed check names when present. Use GitHub's ETA as reported;
do not manufacture one. Clearly label an unavailable review decision, ETA,
rollup, or queue head as unknown. Do not suppress unchanged updates because the
user asked for interval reporting.

## Fail fast

After every snapshot, evaluate terminal states before waiting again. Stop and
report failure immediately when any of these is observed on the current PR head
or current merge-queue head:

1. A check run concludes `FAILURE`, `CANCELLED`, `TIMED_OUT`,
   `ACTION_REQUIRED`, `STARTUP_FAILURE`, or `STALE`.
2. A commit status is `ERROR` or `FAILURE`, or the aggregate rollup is `ERROR`
   or `FAILURE`.
3. The merge-queue entry is `UNMERGEABLE`.
4. The PR is closed without `merged` or `mergedAt` being set.
5. GitHub reports the PR as conflicting (`mergeable: CONFLICTING` or the
   equivalent dirty merge state).
6. A previously observed merge-queue entry disappears while the PR remains
   unmerged. Include the matching removal reason; do not call this a successful
   dequeue.

For a terminal check failure, report its name, workflow when available, state,
conclusion, details URL, and whether it ran on the PR or queue head. Never rerun
it automatically.

Draft status, missing approval, `BLOCKED`, `BEHIND`, `UNSTABLE`, a locked queue,
and pending or expected checks are blocked or waiting states, not terminal CI
failures. Report them and continue because they can change without replacing
the PR. If the user specified an overall deadline, stop at that deadline and
report a timeout distinct from CI or merge-queue failure.

An API transport or GitHub service error is not evidence that the PR failed.
Report the degraded sample and retry at the next interval, but stop after three
consecutive failed samples. Authentication, authorization, invalid target, and
GraphQL schema errors are terminal immediately. Keep retries bounded and stop
promptly on user cancellation.

## Confirm success

Outside the merge queue, success requires fresh API data showing that the pull
request is not a draft, all current PR-head checks have completed without
failure, `mergeable` is `MERGEABLE`, and `mergeStateStatus` is either `CLEAN` or
`BEHIND`. Emit `READY TO MERGE` with the final PR-head CI summary, then stop.
A green `BEHIND` pull request is ready even if branch protection may require an
update before GitHub permits the merge.

After observing a non-null `mergeQueueEntry`, success requires fresh API data
showing `merged: true` or a non-null `mergedAt`. Emit `MERGED` with the merge
timestamp, merge commit SHA when available, final PR-head CI summary, and final
observed merge-queue state. Then stop monitoring.

Do not report queue entry from auto-merge, labels, comments, or merge readiness.
Only a non-null `mergeQueueEntry` establishes queue membership.
