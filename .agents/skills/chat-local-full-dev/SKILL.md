---
name: chat-local-full-dev
description: Prepare, debug, and remove an isolated local Mobius Chat Worker plus the local Platform fixture it depends on. Use when a user asks to run the local Worker, reproduce an API failure locally, watch Worker logs, inspect local D1 or Durable Object SQLite, exercise the browser app against local code, or tear the local Worker down. Do not use it to inspect or change a deployed staging or production Worker; use the worker-debug skill for that.
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
node scripts/local-dev.cjs prepare
```

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

Check health before debugging:

```sh
node scripts/local-dev.cjs status --state-dir <stateDir>
```

Then drive the app with whatever browser tool this environment provides - a
dedicated CLI, the harness browser, Playwright, or manual checks. Do not assume a
specific tool.

## Procedure

1. Validate the checkout. Resolve the repository root with
   `git rev-parse --show-toplevel`; confirm it has `package.json`,
   `vite.config.ts`, and `wrangler.jsonc`. Inspect `git status --short` and keep
   user changes intact.
2. Require the pinned Node.js and pnpm from `package.json` `engines` (Node 24).
   Install locked dependencies only when missing or stale; never upgrade them.
3. Run `node scripts/local-dev.cjs prepare`. It builds the Worker and setup
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
  `ProjectDurableObject`, `BotTriggerRateLimiter`, the attachments R2 buckets,
  and the `EVENTS` queue.
- **Platform fixture** - pinned Wrangler runs
  `packages/e2e/fixtures/wrangler.platform.jsonc` with an explicit
  `--persist-to`. It authenticates local developer calls with provider `e2e` and
  token `mobius-chat-local-e2e`.
- **Configuration** - `prepare` passes variables through Wrangler `--var`
  arguments instead of writing `.dev.vars`, so the checkout is never modified and
  no credentials land on disk. Treat the generated values as local-only secrets.

## Debugging

Read or follow logs:

```sh
node scripts/local-dev.cjs logs --state-dir <stateDir> --worker chat --lines 300
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
- Do not print, log, or commit the generated application secret, RSA key, or
  Slack tokens.
- Keep each run inside its own state directory so runs stay isolated.
- Use only the repository's pinned tools. Verify with `pnpm lint` and
  `pnpm typecheck`; never run `pnpm ci:check` locally.

## Scripts

`scripts/local-dev.cjs` is a dependency-free CommonJS CLI:

- `prepare [--state-dir DIR] [--platform-port N] [--chat-port N] [--force] [--no-build]`
  - provision Platform, seed R2, start both Workers, verify readiness, print the
    JSON descriptor. Idempotent: a live stack is reused, a dead one is replaced.
- `status --state-dir DIR` - report process and HTTP health for a stack.
- `logs --state-dir DIR [--worker chat|platform|all] [--lines N] [--filter REGEX] [--follow]`
  - read or follow captured Worker logs.
- `remove --state-dir DIR [--keep-state]` - stop both process groups and delete the
  state directory.
