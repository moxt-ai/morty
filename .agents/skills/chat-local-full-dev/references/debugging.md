# Debugging the local stack

Work from evidence to root cause. The local stack is a real Worker with real
Durable Objects, so most deployed failure modes reproduce locally.

## Where the evidence is

| Evidence | Location |
| --- | --- |
| Chat Worker output | `chatLog` from `prepare` |
| Platform fixture output | `platformLog` from `prepare` |
| Paired Runtime output | `pairLog` and `<cliState>/logs/daemon.log` from each stack `runtimes` record (`logs --worker runtime`) |
| Chat D1 / Durable Objects / R2 / KV | `chatPersist` |
| Platform D1 / Durable Objects / R2 / KV | `platformPersist` |
| Stack record (pids, origins, paths) | `<stateDir>/stack.json` |

Read logs with `node scripts/local-dev.cjs logs --state-dir <stateDir> ...` rather
than opening files directly, so filtering and following stay consistent.

## Correlating one request

1. Capture the request from the browser tool's network view: method, path, status,
   and the `server-timing` response header. The header names each phase, for
   example `total`, `authentication`, `ownership`, `session`, and `mobius`.
2. Find the matching one-line JSON event in the Chat log (`chat-request-timing`)
   and read its `timings` object. A phase that dominates the total points at the
   boundary to inspect next.
3. If the request crossed into Platform, follow the same path in the Platform log.
4. For failures, read the JSON error object: `err.code` is the stable code, and
   `err.stack` shows the originating module.

## Structured event shapes

Chat emits JSON lines, one per event. Common `event` values:

- `anonymous-user-request-timing`, `chat-request-timing` - per-request timings.
- `chat-workspace-listed`, `chat-agent-settings-discovered`,
  `bot-chat-access-issued`, `session-access-issued` - audit events.
- `runtime-pairing-issued`, `agent-pairing-issued` - management audit events.

Errors are logged as an object with `err.code`, `httpStatus`, and a sanitized
`msg`. Branch on the code, never the message text.

## Inspecting persisted state

Chat D1 tables live under `<chatPersist>/v3/d1/<hash>/`. Durable Object SQLite
lives under `<chatPersist>/v3/do/<class-name>/<id>.sqlite`. Inspect either with
the `sqlite3` CLI:

```sh
sqlite3 <path.sqlite> '.tables'
sqlite3 -header -column <path.sqlite> 'select * from chat_managed_session limit 5;'
sqlite3 -header -column <path.sqlite> 'select * from project_migrations order by id;'
```

Platform control-plane tables live under `<platformPersist>/v3/d1/<hash>/`:

```sh
sqlite3 -header -column <platform-d1.sqlite> \
  'select app_id, display_name, lifecycle from platform_apps;'
```

Durable Object and D1 files are WAL-backed. If a value looks stale, the Worker is
likely still running; stop it with `remove` before reading, or accept the WAL as
part of the live state.

## Common failure modes

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Agent Runtime reconnect loop, close code 1008 `Invalid protocol message` | `third-party/mobius` checkout is older than the published CLI daemon the setup bundle starts | `git submodule status third-party/mobius`; run `git submodule update --init third-party/mobius`, then `prepare --force` |
| Platform Worker process exits after `Can't call WebSocket send() after close()` | Relay sent to a replaced/closing daemon socket without a readyState guard | `platformLog`; the uncaught TypeError is a relay bug - fix it in `third-party/mobius` rather than retrying |
| `PLATFORM_UNAVAILABLE` (502) on first request | Platform D1 schema is older than the code | `platformLog`; re-run `prepare --force` to recreate the state directory |
| `SETUP_ARTIFACT_UNAVAILABLE` (503) on `/setup.mjs` | R2 seed missing in this state directory | Re-run `prepare --force`; confirm the seed step logged success |
| App shows only a spinner, browser console logs `failed_to_load_clerk_js` | Placeholder Clerk publishable key cannot load Clerk JS | Set `CHAT_LOCAL_CLERK_PUBLISHABLE_KEY` to a valid `pk_test_...` before `prepare` |
| `INVALID_REQUEST` (400) with a generic message | Schema validation rejected the body | Find the logged typed error and its validation issue path in `chatLog` |
| `NOT_FOUND` on a Session or Conversation | Wrong Project, or the record lives in another state directory | Inspect `chat_managed_session` and the stack's `appId` |
| Process exited but the port stays bound | A previous stack was not removed | `status` then `remove --state-dir` the old stack |
| Platform health times out with unresolved Mobius packages in `platformLog` | The submodule's independent dependencies were not installed | Re-run the current `scripts/local-dev` entrypoint; for an older checkout run `pnpm --dir third-party/mobius install --frozen-lockfile` first |
| Mobius relay exits because `packages/web/dist` does not exist | Relay web assets were not built after checking out the submodule | Re-run the current `scripts/local-dev` entrypoint without `--no-build` |

## Boundary checklist

When a request fails validation, compare every boundary in order:

1. Browser request construction and serialized body size.
2. Chat Worker global body limit, route body limit, and schema.
3. Platform gateway request construction.
4. Platform Worker body parser and schema.
5. Runtime or agent protocol validation.

## Reproduce with a narrow API call

For a contract-level reproduction, call the Chat HTTP API directly against
`chatOrigin`. A first-time visitor must mint an anonymous identity first:

```sh
curl -sS -X POST "$CHAT_ORIGIN/morty/api/identity/anonymous-users" \
  -H 'content-type: application/json' -d '{}'
```

The response carries the browser identity, including the Project ID and token.
Reuse those as `authorization: Bearer <token>` against
`/morty/api/chat/projects/<projectId>/...`. Keep tokens out of transcripts
and logs.

## Escalating to deployed environments

If the failure only appears in a deployed environment, stop and use the
`worker-debug` skill. Never point a local stack at a Cloudflare account, and never
run `wrangler tail` or `wrangler deploy` from this skill.
