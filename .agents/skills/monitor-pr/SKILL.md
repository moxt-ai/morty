---
name: monitor-pr
description: Monitor a GitHub pull request until ready to merge or confirm that it has merged. Use when a user asks to watch, monitor, wait for, or merge a PR, including follow-through after enabling auto-merge or entering the merge queue.
---

# Monitor a Pull Request

Use the bundled monitor script. It owns target resolution, GitHub snapshots,
pagination, polling, status reports, merge-queue tracking, and terminal results.
Do not replace it with individual GitHub CLI calls or another monitoring loop.

From the repository root, run:

```sh
node .agents/skills/monitor-pr/scripts/monitor-pr.cjs
```

This monitors the current branch's PR. For an explicit PR, use:

```sh
node .agents/skills/monitor-pr/scripts/monitor-pr.cjs --pr NUMBER
```

The `--pr` option also accepts a canonical HTTPS GitHub PR URL. Use `--repo
OWNER/REPO` when selecting a different repository. Pass arguments as separate,
safely quoted values, never as interpolated shell syntax. Run the script with
`--help` for supported options. If target resolution is ambiguous or fails, ask
the user rather than guessing.

Keep the script in a cancellable foreground tool call in the active conversation.
Do not background it, delegate it, or claim monitoring will continue after a final
answer. Surface the script's status output and summarize its terminal result.
If the tools cannot keep it attached and cancellable, report that limitation.
On failure, report the blocker; do not automatically rerun checks or restart a
failed monitor.

## Completion and merge authorization

Monitoring is read-only. A watch request does not authorize approving, updating,
rerunning, enqueueing, dequeuing, closing, or merging a PR. Perform those actions
only when separately authorized by the user, and respect repository protections.

For a readiness request, `READY TO MERGE` completes the task. Once the script
observes a merge-queue entry, it follows that entry until `MERGED` or failure.

When the user asks to merge, `READY TO MERGE` is only an intermediate result.
Perform the authorized merge action, then call the script again for the same PR
to confirm `MERGED`. Enabling auto-merge or requesting queue entry is not proof
of a merge. If another script invocation returns `READY TO MERGE`, the merge
request remains incomplete; do not report success. If the merge action is
rejected, report the blocker rather than bypassing protections.
