---
name: chat-local-web-dev
description: Start the current Mobius Chat checkout locally, pair it with the current harness session, and return a localhost handoff URL that can be redeemed up to five times. Use when the user asks to run, preview, pair, or share the local Chat web app.
---

# Mobius Chat Web Development

Start this checkout's local Chat app, pair a Runtime with the current harness
session, and return the generated localhost browser handoff. The handoff supports
up to five successful redemptions. Do not substitute a deployed or remote origin.

## Validate the checkout

Resolve the repository root with `git rev-parse --show-toplevel` and use that
absolute path for repository commands. Confirm it contains `package.json`,
`vite.config.ts`, and `wrangler.jsonc`. Inspect `git status --short` without
modifying or discarding user changes.

Require the repository's pinned Node.js and pnpm versions. Install locked
dependencies only when missing or stale. Do not upgrade dependencies.

## Prepare local services

The Chat Worker requires a configured Mobius Platform. If an existing healthy
local Platform and valid `.dev.vars` already configure this checkout, reuse them.
Never overwrite an existing `.dev.vars`.

Otherwise use the repository's local Platform fixture on `127.0.0.1:8788`:

1. Create a private persistence directory under the approved harness temporary
   directory.
2. Apply `PLATFORM_DIRECTORY_DATABASE` migrations with
   `packages/e2e/fixtures/wrangler.platform.jsonc` and the pinned Wrangler from
   `third-party/mobius`.
3. Start that Worker with background execution, port 8788, and the same
   persistence directory. Require an HTTP 200 health response from
   `/mobius/api/dashboard/health`.
4. Provision a local Platform application through the fixture's authenticated
   developer API. Validate the returned application ID and credential locally.
5. Create an owner-only, ignored `.dev.vars` with the generated application
   credential, `MOBIUS_BASE_URL=http://127.0.0.1:8788`, local Chat origins, a
   generated RSA public key, and fresh random local-only Slack secrets. Keep
   credentials out of command arguments and responses.

Build the setup bundle with `pnpm build:setup`, then seed
`artifacts/setup.mjs` in the local `mobius-chat-local-apac-attachments` R2 bucket
using the repository's documented Wrangler command. This is required before
fetching `/setup.mjs`; a 503 `SETUP_ARTIFACT_UNAVAILABLE` means it has not been
seeded in the active local persistence state.

## Start the local app

Use this exact origin:

```text
http://localhost:5173
```

If port 5173 is already served by a healthy `pnpm dev` process from this checkout,
reuse it. If another process owns the port, report the conflict without stopping
it. Otherwise run `pnpm dev` with the harness's background execution support.
Keep the process attached to the harness lifecycle; do not impose a five-minute
server timeout and do not detach it into an unmanaged daemon.

Wait for Vite to report readiness, then make one bounded request to
`http://localhost:5173/`. Continue only after an HTTP 200 response.

## Pair the current session

Use the current harness ID (`codex`, `claude`, or `opencode`) and the current
conversation's exact session ID from trusted local harness metadata. Never invent
either value.

Fetch `http://localhost:5173/setup.mjs` into a new private temporary directory
with redirects disabled and a finite timeout. Require HTTP 200 and a JavaScript
content type. Verify the artifact is a regular non-symlink file within that
directory and parses with `node --check`. Set the directory to mode `0700` and
the file to mode `0600`.

Use `DOCUMENT_DIR` when set; otherwise resolve the user's Documents directory
locally. Run the setup bundle with background execution support:

```sh
node "$SCRIPT_DIR/setup.mjs" setup \
  --base-url http://localhost:5173 \
  --harness "$HARNESS" \
  --session-id "$SESSION_ID"
```

The setup process owns the paired Runtime and must remain attached to the harness
lifecycle after readiness. Do not terminate another Runtime or create a remote
production pairing to work around a local failure.

Wait up to five minutes for structured output with `status: "ready"`. Success
requires a URL whose origin is exactly `http://localhost:5173`, whose path is
`/continue`, and whose fragment contains a transfer code, plus a valid ISO
`expiresAt`. Do not open, preview, scan, or redeem the URL because that consumes
one of its five uses.

## Return the handoff

Return the exact clickable `url` and `expiresAt` from the ready record. Mention
that it can be successfully opened up to five times and works only while the
local app and paired Runtime remain online. Include QR paths when setup returns
them, but never expose saved credentials or configuration files.

If setup returns a typed error or does not become ready within five minutes,
report the error instead of returning the unpaired homepage URL.
