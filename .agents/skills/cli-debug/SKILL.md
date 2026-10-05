---
name: cli-debug
description: Debug Mobius CLI daemon failures on a user's local machine using the bounded local diagnostic log. Use when a user asks why a local Agent operation failed (for example a native session import, fork, or preview returning "The local agent operation could not be completed."), where the daemon writes diagnostics, how to read logs/daemon.log, or how to correlate a Platform relay failure code with the local cause.
---

# CLI Debugging

Investigate Mobius CLI (local daemon) failures from the local diagnostic log to
root cause. The daemon keeps its own evidence on the user's machine; prefer that
file over asking the user to reproduce or enabling verbose output.

## Establish the target

Resolve the state directory before anything else. It is the root of all local
daemon state and diagnostics:

| Precedence | Source | Path |
| --- | --- | --- |
| 1 | `MOBIUS_STATE_DIRECTORY` environment variable of the daemon process | its value |
| 2 | default | `~/.mobius` |

Read the variable from the environment the daemon actually runs in (for example
the shell or service definition that started it); do not assume your current
shell matches. When it is unset, use `~/.mobius`.

The diagnostic log is one file:

```text
<state directory>/logs/daemon.log
```

Created lazily on the first recorded diagnostic, reused across daemon restarts,
mode `0600` inside a mode `0700` `logs/` directory, and bounded at 1 MiB: when a
new record would exceed the limit, the oldest complete lines are removed first,
so the newest history is always retained.

Confirm the CLI version the user runs (`mobius --version` or the installed
package version). The bounded log exists from CLI version `0.0.72`; earlier
versions only wrote to stderr, so an absent `logs/daemon.log` on an older
version is expected and should be reported, not worked around.

## Read the log

Each line is one JSON diagnostic with a stable prefix:

```text
Mobius relay diagnostic {"channelId":"...","event":"relay_connection_failed",...}
Mobius daemon diagnostic {"channelId":"...","event":"native_session_operation_failed","requestId":"...",...,"failureName":"Error","failureMessage":"...","failureCode":"...","cause1Name":"...","cause1Message":"..."}
```

Extract evidence with line-oriented tools; the file is small by design:

```sh
tail -n 200 ~/.mobius/logs/daemon.log
grep '"event":"native_session_operation_failed"' ~/.mobius/logs/daemon.log | tail -n 5
```

Event families written to the log:

| `event` | Meaning |
| --- | --- |
| `relay_connection_opened` / `relay_connection_closed` / `relay_connection_failed` | relay WebSocket lifecycle, including close code, reason, and source |
| `relay_heartbeat_timed_out` | liveness deadline expired; daemon reconnected |
| `relay_reconciliation_abandoned` | daemon gave up on turns the Relay already settled |
| `agent_settings_discovery_failed`, `agent_settings_model_unsupported` | Agent settings discovery failures and unsupported model selections |
| `agent_catalog_refresh_failed` | local Agent catalog refresh failure |
| `native_session_operation_failed` | native session list/find/preview/import/fork failure |
| `native_session_turn_fork_failed` | turn-scoped fork failure |

For failure events, read the cause chain fields `failureName`,
`failureMessage`, `failureCode`, then `cause1*`, `cause2*` for the underlying
error. The message is sanitized before it is written: control characters are
replaced, credential-looking query parameters are redacted, URLs are reduced to
their origin, and the line is truncated. Treat redaction markers (`[redacted]`,
`[redacted-url]`, `[local-path]`) as evidence of sanitization, not corruption.

Note what is intentionally not in the log: full stdout/stderr of child Agents,
prompt content, and session transcripts. Do not try to recover those from this
file; the per-channel audit database under `<state directory>/audit/` and
`channels/` remains the deeper local store when a fix needs more evidence.

## Correlate a remote failure

When the user reports a failure seen in Chat or the Platform relay (for example
code `session_operation_failed` or the generic "The local agent operation could
not be completed." message), the UI message is collapsed at the daemon boundary
on purpose; the concrete cause is only in the local log.

Correlate by:

1. Time window: convert the user-visible failure time to the same clock and
   inspect that range of lines.
2. `channelId`: match the paired channel the user's Bot uses.
3. `requestId` or `sessionId`: match when the reporter can supply one.
4. `agentId` and `action` (`list`/`find`/`preview`/`import`/`fork`) on
   `native_session_operation_failed` events.

Keep the daemon's error taxonomy straight when interpreting codes:
`native_session_busy` is the daemon's own per-agent native-operation guard (a
concurrent operation was still running), not an Agent or Codex lock; Agent-side
rejections surface as typed Agent/ACP error codes such as `acp_agent_error`
inside `failureCode`. Report which layer produced the code.

## Boundaries and safety

The log and state directory belong to the user's machine. Read it only with the
user's direction for the failure being investigated, quote only the lines needed
for diagnosis, and redact personal or workspace paths when reporting. Never
delete, truncate, rotate, or rewrite `daemon.log` while diagnosing; trimming is
the daemon's own behavior. Do not disable or raise the 1 MiB bound to "keep more
history" — if the needed evidence was already trimmed, say so.

Distinguish evidence sources:

- `logs/daemon.log`: durable local diagnostics (this skill's primary source).
- Daemon stderr/stdout lines (`Mobius daemon diagnostic ...`, `Mobius relay
  diagnostic ...`): same events, ephemeral console stream.
- Local `wrangler dev` or Chat web output: not evidence of daemon behavior.

## Implement and verify a fix

When the log reveals a defect, state the user-visible slice and add the
repository's required failing Given-When-Then acceptance scenario at the first
supported boundary. The user may explicitly ask for manual verification only;
in that case exercise the behavior with a scratch script outside the repository
and delete it afterward. Preserve typed error codes and sanitized messages at
every boundary, and keep new daemon-side failures wired into
`DaemonDiagnosticLog` so they remain diagnosable locally.

Run only relevant tests, then `pnpm lint` and `pnpm typecheck` in the
`third-party/mobius` submodule. Never run `pnpm ci:check` locally. Do not
publish or release the CLI unless the user explicitly asks.

## Report findings

Return:

1. State directory, CLI version, and the log file used.
2. The matched diagnostic line(s), time window, and correlation identifiers.
3. The concrete cause chain and which layer produced it (daemon guard, local
   authorization, Agent/ACP rejection, relay connectivity).
4. Fix and verification performed, or the next missing piece of evidence.

Redact secrets, tokens, and personal paths. It is acceptable to report that the
relevant lines were already trimmed by the 1 MiB bound or that the installed CLI
predates the log; it is not acceptable to claim the daemon "has no logs"
without checking `logs/daemon.log`.
