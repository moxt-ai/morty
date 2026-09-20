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

Inspect `git submodule status` before using the local Platform fixture. A leading
`+` means the checked-out Mobius source does not match the revision recorded by
the superproject, and the fixture can fail with missing exports, dependencies, or
generated migration modules. Never repair or replace a user's modified submodule.
Instead, create a detached temporary worktree at the current superproject `HEAD`,
initialize its recorded Mobius submodule, install both frozen lockfiles when
needed, and generate the committed-revision SQL modules there. Use that temporary
worktree only for the Platform process; keep Chat and the session CWD in the
requested checkout.

## Prepare local services

The Chat Worker requires a configured Mobius Platform. If an existing healthy
local Platform and valid `.dev.vars` already configure this checkout, reuse them.
Never overwrite an existing `.dev.vars`.

A Platform health response validates only that the Worker is live; it does not
prove that its persisted applications match `MOBIUS_APP_ID` and
`MOBIUS_APP_SECRET`. Before treating an existing Platform persistence directory
as reusable, require the saved application credential to be accepted. A
`PLATFORM_APP_UNAUTHORIZED` setup failure means the persistence directory and
`.dev.vars` do not match. Do not retry against arbitrary persistence directories
or overwrite `.dev.vars`; locate the matching local persistence state, or report
the conflict and ask before replacing the local configuration with newly
provisioned credentials.

The setup configuration under the resolved Documents directory preserves its
identity whenever `base_url` remains the same. Fresh temporary Platform and Chat
state at the same localhost origin therefore must not reuse an identity created
for older persistence. Never delete or rewrite the user's saved setup
configuration to fix this. For a user-approved temporary configuration workflow,
use a new private temporary Documents directory so setup creates isolated local
identity and Runtime state.

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
locally. Always export the resolved absolute path for the setup process. Merely
running the command with the Documents directory as its CWD is insufficient and
causes the bundle to reject an empty `DOCUMENT_DIR`. Run the setup bundle with
background execution support:

```sh
DOCUMENT_DIR="$RESOLVED_DOCUMENTS_DIR" node "$SCRIPT_DIR/setup.mjs" setup \
  --base-url http://localhost:5173 \
  --cwd "$PWD" \
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

## Capture requested previews

Skip this section unless the user explicitly asks to open, preview, or capture
the local app. In that case, redeem the ready handoff exactly once in the browser,
confirm the resulting page remains on the `http://localhost:5173` origin, and
capture only the requested states. Write screenshots or other requested artifacts
to the user's requested repository-relative directory, creating it when needed;
do not place credentials, the transfer URL, or configuration files there. Report
the artifact paths and that the handoff has at most four successful redemptions
remaining. Do not return or separately open the handoff again after redeeming it.
If the continuation page asks whether to import or fork the native harness
session, choose **Fork session** for preview work so the original session is not
continued or mutated. Choose **Import session** only when the user explicitly
requests that behavior.

## Return the handoff

When the handoff was not redeemed for a requested preview, return the exact
clickable `url` and `expiresAt` from the ready record. Mention that it can be
successfully opened up to five times and works only while the local app and
paired Runtime remain online. Include QR paths when setup returns them. When the
preview workflow already redeemed the handoff, return the captured artifact paths
instead and do not expose the transfer URL. Never expose saved credentials or
configuration files.

If setup returns a typed error or does not become ready within five minutes,
report the error instead of returning the unpaired homepage URL.
