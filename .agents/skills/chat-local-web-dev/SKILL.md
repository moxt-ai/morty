---
name: chat-local-web-dev
description: Start the current Mobius Chat checkout locally against the staging Platform, pair it with the current harness session, and return a localhost handoff URL that can be redeemed up to five times. Use when the user asks to run, preview, pair, or share the local Chat web app.
---

# Mobius Chat Web Development

Start this checkout's local Chat app against the staging Mobius Platform, pair a
Runtime with the current harness session, and return the generated localhost
browser handoff. The handoff supports up to five successful redemptions. Chat
stays local even when a tunnel is used to make its callback origin reachable.

## Validate the checkout

Resolve the repository root with `git rev-parse --show-toplevel` and use that
absolute path for repository commands. Confirm it contains `package.json`,
`vite.config.ts`, and `wrangler.jsonc`. Inspect `git status --short` without
modifying or discarding user changes.

Require the repository's pinned Node.js and pnpm versions. Install locked
dependencies only when missing or stale. Do not upgrade dependencies.

## Configure the staging Platform

Use the staging Platform endpoint documented by this checkout, currently
`https://mobius.moxt.ws`. Do not start the local Platform fixture for this skill.
Require an HTTP 200 response from `/mobius/api/dashboard/health` before starting
Chat.

Read the staging App credential from `MOBIUS_CHAT_LOCAL_APP_ID` and
`MOBIUS_CHAT_LOCAL_APP_SECRET` in the process environment. Require both values
to be non-empty and validate their presence without printing either value. Map
them to the local Chat Worker's `MOBIUS_APP_ID` and `MOBIUS_APP_SECRET` bindings;
do not fall back to credentials stored in `.dev.vars*`.
Never provision a production App, copy deployed Worker secrets, or write secrets
to command output. Treat `PLATFORM_APP_UNAUTHORIZED` as evidence that the local
credential belongs to another Platform environment: stop the new local processes,
remove the private runtime snapshot, and report the missing staging credential
instead of falling back to another Platform.

Reuse existing owner-only `.dev.vars` values for Clerk and local-only Slack
configuration, and take the App credential only from the two process environment
variables above; do not trust stale `MOBIUS_BASE_URL`, `MOBIUS_APP_ID`,
`MOBIUS_APP_SECRET`, or `APP_ORIGIN` values in `.dev.vars*`.
Ordinary shell variable overrides do not supersede `.dev.vars`
bindings in Cloudflare's Vite plugin, and selecting `CLOUDFLARE_ENV=staging`
filters out local-only bindings that are not declared in the deployed environment.

Never overwrite or rename the checkout's `.dev.vars`. When its origins do not
already match this run, create a private runtime snapshot under the approved
harness temporary directory. Copy the current working tree, including uncommitted
source changes, while excluding `.git`, `node_modules`, build output, Wrangler
state, `.dev.vars*`, and `test-results`; link the snapshot to the checkout's pinned
root and package-level `node_modules` directories. If the rebased Mobius submodule's
locked dependencies are stale, run `pnpm install --frozen-lockfile` in that
submodule before linking them; never upgrade. A linked root `node_modules` causes
pnpm's task-state safety check to reject filtered scripts, so invoke the pinned
Vite and Wrangler JavaScript entrypoints directly from the snapshot instead of
running `pnpm` there. Create an owner-only `.dev.vars` only inside that snapshot by
combining non-Platform local values with the staging App credential from the
process environment, then replace `MOBIUS_BASE_URL` with the staging Platform
origin and `APP_ORIGIN` with the selected Chat callback origin. Build, seed local
R2, and start Vite from the snapshot without `CLOUDFLARE_ENV`.

If the local Chat must receive an HTTPS callback, start or reuse a tunnel that
targets the selected local Chat port and use that tunnel only as `APP_ORIGIN`;
`MOBIUS_BASE_URL` still points to the staging Platform. Remove the private runtime
snapshot after stopping its processes.

Build the setup bundle with `pnpm build:setup` when running from the checkout. In
a linked runtime snapshot, run the pinned Vite JavaScript entrypoint from
`packages/setup` instead. Then seed `artifacts/setup.mjs` in the local
`mobius-chat-local-apac-attachments` R2 bucket using the repository's documented
Wrangler command, or its pinned JavaScript entrypoint in a linked snapshot. This
is required before fetching `/setup.mjs`; a 503 `SETUP_ARTIFACT_UNAVAILABLE`
means it has not been seeded in the active local persistence state.

## Start the local app

Prefer this origin:

```text
http://localhost:5173
```

If port 5173 is already served by a healthy `pnpm dev` process from this checkout,
reuse it. If another process owns the port, do not stop or reuse that process.
Select an unused loopback port, starting at 5174, and run
`pnpm exec vite --port "$CHAT_PORT"` with the harness's background execution
support. Derive `CHAT_ORIGIN=http://localhost:$CHAT_PORT`; do not leave literal
5173 assumptions in later commands. Keep the process attached to the harness
lifecycle; do not impose a five-minute server timeout and do not detach it into
an unmanaged daemon. Do not use `pnpm dev -- --port`; the extra literal `--`
causes this checkout's Vite invocation to keep the configured port 5173.

Wait for Vite to report readiness, then make one bounded request to
`$CHAT_ORIGIN/`. Continue only after an HTTP 200 response. Confirm the startup
bindings show the staging Platform origin and the intended callback origin;
otherwise stop this new process and report the configuration mismatch.

## Pair the current session

Use the current harness ID (`codex`, `claude`, or `opencode`) and the current
conversation's exact session ID from trusted local harness metadata. Never invent
either value.

Fetch `$CHAT_ORIGIN/setup.mjs` into a new private temporary directory
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
  --base-url "$CHAT_ORIGIN" \
  --cwd "$PWD" \
  --harness "$HARNESS" \
  --session-id "$SESSION_ID"
```

The setup process owns the paired Runtime and must remain attached to the harness
lifecycle after readiness. Do not terminate another Runtime or create a remote
production pairing to work around a local failure.

Wait up to five minutes for structured output with `status: "ready"`. Success
requires a URL whose origin is exactly `$CHAT_ORIGIN`, whose path is
`/continue`, and whose fragment contains a transfer code, plus a valid ISO
`expiresAt`. Do not open, preview, scan, or redeem the URL because that consumes
one of its five uses.

## Capture requested previews

Skip this section unless the user explicitly asks to open, preview, or capture
the local app. In that case, redeem the ready handoff exactly once in the browser,
confirm the resulting page remains on the `$CHAT_ORIGIN` origin, and capture only
the requested states. Write screenshots or other requested artifacts to the
user's requested repository-relative directory, creating it when needed; do not
place credentials, the transfer URL, or configuration files there. Report the
artifact paths and that the handoff has at most four successful redemptions
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
