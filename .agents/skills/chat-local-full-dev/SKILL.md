---
name: chat-local-full-dev
description: Prepare, debug, and remove an isolated local Morty Worker plus the local Platform fixture it depends on. Use when a user asks to run the local Worker, reproduce an API failure locally, watch Worker logs, inspect local D1 or Durable Object SQLite, exercise the browser app against local code, or tear the local Worker down. Do not use it to inspect or change a deployed staging or production Worker; use the worker-debug skill for that.
---

# Local Full-Stack Development

Run a disposable, isolated copy of this checkout: the Chat Worker with its Durable
Objects, queues, R2, and static assets, plus the local Platform fixture it
authenticates against. Everything is process-local and removable. Nothing here
deploys, and nothing here touches Cloudflare accounts.

This skill is for reproducing and diagnosing behavior in code you are changing.
For deployed logs and incidents use `worker-debug`.

## Quick start

```sh
scripts/local-dev web-server
```

The repository provides one local-development entrypoint, `scripts/local-dev`.
The `web-server` mode provisions an isolated local Platform App automatically.
The `web` mode reads owner-provided `MORTY_LOCAL_APP_ID` and
`MORTY_LOCAL_APP_SECRET` values for the configured remote Platform.

Modes:

| Mode | Services | Platform |
| --- | --- | --- |
| `web` | local Chat web/Worker | staging Platform |
| `web-server` | local Chat web/Worker + local Mobius Platform | local |
| `web-server-mobius` | compatibility alias for `web-server` | local |
| `web-server-mobius-cli` | mode above + checkout Mobius CLI check | local |

Examples:

```sh
scripts/local-dev web
scripts/local-dev web-server
scripts/local-dev web-server-mobius
scripts/local-dev web-server-mobius-cli
```

Use `node scripts/local-dev.cjs ...` for status, logs, and removal. The
`prepare` command remains available for automation and accepts explicit
`--app-id` and `--app-secret` arguments. The local Platform uses the live Session
relay and is non-cloud-only; `local-dev.cjs` does not launch a separate standalone
Mobius Worker.

`prepare` stays attached in the foreground after it prints its ready record.
For agent-driven development, start the wrapper in the background and poll
`node scripts/local-dev.cjs status --state-dir <stateDir>`; the record contains
the Chat URL and, for server modes, the local Platform URL. Stop it
with Ctrl-C or use `remove` when finished.

`prepare` prints one JSON object on stdout. Progress goes to stderr, so stdout
stays parseable. Read these fields instead of assuming defaults:

| Field | Meaning |
| --- | --- |
| `chatOrigin` | Chat Worker and browser origin. Default `http://localhost:5173`. |
| `platformOrigin` | Local Platform the Chat Worker calls. Default `http://127.0.0.1:8788`. |
| `stateDir` | Everything this run created: logs, persistence, the stack record. |
| `chatLog`, `platformLog` | Captured Worker output. |
| `chatPersist`, `platformPersist` | Wrangler persistence roots (D1, Durable Objects, R2, KV). |
| `chatPid`, `platformPid` | Root process IDs, managed as process groups. |
| `appId` | Provisioned local Platform application. |

Every start uses Wrangler's local `--persist-to`, so each state directory owns its
own D1, Durable Objects, R2, and KV data. Wrangler still keeps a small per-project
registry under `<repo>/.wrangler/state`, so run one stack per checkout at a time.
Omit `--state-dir` for `prepare`: the CLI generates a fresh temporary directory so
concurrent checkouts do not share local state or Mobius CLI managers. Use the
returned `stateDir` for all later `pair`, `status`, `logs`, and `remove` commands.

Check health before debugging:

```sh
node scripts/local-dev.cjs status --state-dir <stateDir>
```

Before pairing an agent Runtime, verify the `third-party/mobius` submodule
matches the commit recorded by the branch
(`git submodule status third-party/mobius`); a stale checkout speaks an older
relay protocol than the published CLI daemon and fails with WebSocket close
code 1008 `Invalid protocol message`. Repair with
`git submodule update --init third-party/mobius` and re-run `prepare --force`.

Then drive the app with whatever browser tool this environment provides - a
dedicated CLI, the harness browser, Playwright, or manual checks. Do not assume a
specific tool.

## Procedure

1. Validate the checkout. Resolve the repository root with
   `git rev-parse --show-toplevel`; confirm it has `package.json`,
   `vite.config.ts`, and `wrangler.jsonc`. Inspect `git status --short` and keep
   user changes intact.
2. Require the pinned Node.js and pnpm from `package.json` `engines` (Node 24).
   Install locked root dependencies only when missing or stale; never upgrade them.
   The local-development entrypoint checks the Mobius submodule's independent
   `pnpm-lock.yaml`, installs its dependencies when they are missing or stale,
   and generates its migration modules.
   If diagnosing startup manually, use
   `pnpm --dir third-party/mobius install --frozen-lockfile`; a root `pnpm install`
   does not install the submodule workspace.
3. Run `scripts/local-dev web-server`. It builds the Worker and setup
   bundle by default; pass `--no-build` only when those artifacts are fresh.
4. Reproduce through a supported boundary: the browser app for user flows, or the
   Chat HTTP API for a narrower contract. Prefer the real app so the reproduction
   matches what a user sees.
5. When verifying a browser behavior, capture representative user-journey states
   as PNG screenshots under `<repo>/test-results/`. Use descriptive names such as
   `test-results/<journey>-before.png` and
   `test-results/<journey>-after.png`; capture the smallest set that demonstrates
   the behavior. Drive every captured state through normal mouse or keyboard
   interactions. Never capture credentials, pairing tickets, private configuration,
   or other secrets. Treat these screenshots as local verification artifacts and
   report their repository-relative paths. Retain the PNG files after stack
   teardown; cleanup must never remove verification artifacts from
   `<repo>/test-results/`.
6. Read `references/debugging.md` before concluding a root cause. It covers where
   logs go, which structured events and headers to correlate, and how to inspect
   D1 and Durable Object SQLite.
7. Remove the stack when finished without removing retained screenshots:

```sh
node scripts/local-dev.cjs remove --state-dir <stateDir>
```

## Process model

- **Chat Worker** - pinned Wrangler runs `packages/e2e/fixtures/wrangler.chat.jsonc`
  from the built Worker bundle with the built SPA as assets. It owns
  `ProjectDurableObject` and the attachments R2 buckets.
- **Platform fixture and relay** - pinned Wrangler runs
  `packages/e2e/fixtures/wrangler.platform.jsonc` with an explicit
  `--persist-to`. It authenticates local developer calls with provider `e2e` and
  token `morty-local-e2e`. `prepare` creates or updates its App on the non-cloud-only
  live Session relay.
- **Configuration** - `prepare` passes variables through Wrangler `--var`
  arguments instead of writing `.dev.vars`, so the checkout is never modified and
  no credentials land on disk. Treat the generated values as local-only secrets.

## Pairing a local agent Runtime

`prepare` only starts the web and relay services. To exercise a real agent
(for example Codex or Claude Code) through the local stack, run:

```sh
node scripts/local-dev.cjs pair --state-dir <stateDir> [--harness codex] [--workspace DIR]
```

`pair` mints a fresh browser identity and one-time pairing ticket against the
local Chat Worker, downloads the served `setup.mjs`, and runs its `pair` flow
with Morty's files isolated under the state directory:

- `DOCUMENT_DIR` is set to `<stateDir>/documents`, so the setup script writes
  its private configuration there instead of the user's documents directory.
- Mobius receives `MOBIUS_STATE_DIRECTORY=<stateDir>/mobius`, so every generated
  stack uses an isolated CLI manager and connection state. This prevents another
  checkout with a different CLI version from restarting or replacing its manager.
- `--workspace` defaults to `<stateDir>/workspace`, the paired default
  workspace.

The command waits until the Runtime reports ready (up to five minutes), then
prints one JSON record on stdout with `browserIdentity`
(`token`, `userId`, `projectId`), `botId`, `workspace`, `pairLog`, and
`runtimePid`. Inject the identity into the browser before opening the app:

```js
localStorage.setItem(
    "mobius.anonymous-credential.v2",
    JSON.stringify({ token, userId, projectId }),
);
localStorage.setItem(
    "mobius.workspace.v2",
    JSON.stringify({ userId, projectId }),
);
```

Paired setup commands and their Connection IDs are recorded in the stack record.
`remove` stops those connections by Connection ID without stopping the shared
Mobius manager or its other connections. The pairing ticket binds to the freshly
minted identity, so a browser that already holds another identity must clear or
overwrite the two localStorage keys above. Runtime setup output is written to
`pairLog` and is available through `logs --worker runtime`.

## Debugging

Read or follow logs:

```sh
node scripts/local-dev.cjs logs --state-dir <stateDir> --worker chat --lines 300
node scripts/local-dev.cjs logs --state-dir <stateDir> --worker runtime --lines 300
node scripts/local-dev.cjs logs --state-dir <stateDir> --worker all --follow
node scripts/local-dev.cjs logs --state-dir <stateDir> --filter 'PLATFORM_UNAVAILABLE|ERROR'
```

Key facts:

- Each request emits a one-line JSON event such as `chat-request-timing` or a
  `*-audit-event`, and every Chat response carries a `server-timing` header that
  breaks the total into named phases.
- Worker errors surface as a JSON object with `err.code` (a stable machine-readable
  code), `httpStatus`, and a sanitized `msg`. Branch on `err.code`, never on the
  message text.
- The browser sees only the sanitized code, so a UI message alone is rarely the
  whole cause; correlate it with the recorded Worker event.

Details, inspection commands, and a failure-mode table are in
`references/debugging.md`.

## Constraints

- Local only. Never run `wrangler deploy`, `wrangler tail`, or any command that
  reaches a Cloudflare account from this skill.
- Do not print, log, or commit the generated application secret or RSA key.
- Keep each run inside its own state directory so runs stay isolated.
- Use only the repository's pinned tools. Verify with `pnpm lint` and
  `pnpm typecheck`; never run `pnpm ci:check` locally.

## Scripts

`scripts/local-dev.cjs` is a dependency-free CommonJS CLI:

- `prepare [--state-dir DIR] [--platform-port N] [--chat-port N] [--force] [--no-build]`
  - provision Platform, seed R2, start both Workers, verify readiness, print the
    JSON descriptor. Idempotent: a live stack is reused, a dead one is replaced.
    The local Platform App is provisioned automatically.
- `pair --state-dir DIR [--harness ID] [--workspace DIR]`
  - pair a local agent Runtime through the served setup bundle with
    `DOCUMENT_DIR` isolated under the state directory while using the normal
    singleton Mobius manager; prints the browser identity to adopt.
- `status --state-dir DIR` - report process and HTTP health for a stack.
- `logs --state-dir DIR [--worker chat|platform|runtime|all] [--lines N] [--filter REGEX] [--follow]`
  - read or follow captured Worker and paired Runtime logs.
- `remove --state-dir DIR [--keep-state]` - stop both process groups and delete the
  state directory.
