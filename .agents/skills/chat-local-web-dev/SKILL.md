---
name: chat-local-web-dev
description: Start the current Mobius Chat checkout locally against the staging Platform, open its browser workspace, and pair that workspace with the current harness through /pair.md. Use when the user asks to run, preview, pair, or share the local Chat web app.
---

# Mobius Chat Web Development

Start this checkout's local Chat app against the staging Mobius Platform, open
its browser workspace, and use that workspace's `/pair.md` instruction to pair a
Runtime with the current harness. Return the localhost Chat URL after pairing.
Chat stays local even when a tunnel is used to make its callback origin
reachable.

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

Use the current harness ID (`codex`, `claude`, `opencode`, or `oh-my-pi`) from trusted local
harness metadata. Never invent it.

Open `$CHAT_ORIGIN/` in the browser to create or restore the local Chat workspace.
Confirm that navigation remains on the exact `$CHAT_ORIGIN` origin. Obtain the
one-time pairing instruction through the product UI: wait for the element with
the shared `chat-pairing-instruction` test ID and read its `follow
$CHAT_ORIGIN/pair.md?token=...` value. Do not call the pairing API directly and do
not read browser storage. If the pairing dialog is not already visible, open it
through the connection-status control. Require the URL origin to equal
`$CHAT_ORIGIN`, the path to equal `/pair.md`, and the query to contain only a
valid `mobius_pair_v2` token. Keep the URL and token private and never print them.

Fetch that exact `/pair.md?token=...` URL with redirects disabled and a finite
timeout. Require HTTP 200 and a Markdown content type. Fetching the document does
not consume the ticket. Follow the checked-out document's pairing instructions;
do not substitute the standalone `setup` identity flow.

Fetch `$CHAT_ORIGIN/setup.mjs` into a new private temporary directory
with redirects disabled and a finite timeout. Require HTTP 200 and a JavaScript
content type. Verify the artifact is a regular non-symlink file within that
directory and parses with `node --check`. Set the directory to mode `0700` and
the file to mode `0600`.

Use `DOCUMENT_DIR` when set; otherwise resolve the user's Documents directory
locally. Always export the resolved absolute path for the setup process. Merely
running the command with the Documents directory as its CWD is insufficient and
causes the bundle to reject an empty `DOCUMENT_DIR`. Extract the token from the
validated pairing URL into a process-local variable without writing it to output.
Run the setup bundle with background execution support:

```sh
DOCUMENT_DIR="$RESOLVED_DOCUMENTS_DIR" node "$SCRIPT_DIR/setup.mjs" pair \
  --base-url "$CHAT_ORIGIN" \
  --cwd "$PWD" \
  --harness "$HARNESS" \
  --token="$TOKEN"
```

The setup process owns the paired Runtime and must remain attached to the harness
lifecycle after readiness. Do not terminate another Runtime or create a remote
production pairing to work around a local failure.

Wait up to five minutes for structured output with `status: "ready"`. Success
requires a URL equal to `$CHAT_ORIGIN` plus non-empty `botId` and `workspace`
values. The browser workspace that issued the ticket is already the paired Chat
session; do not create an identity transfer or `/continue` handoff.

## Capture requested previews

Skip this section unless the user explicitly asks to open, preview, or capture
the local app. In that case, return to or reload the existing `$CHAT_ORIGIN`
browser tab after pairing, confirm it remains on the exact local origin, and
drive the requested journey through normal mouse or keyboard interactions.
Capture a small set of representative states as PNG screenshots, including the
state before the relevant action and the observable result when both are useful.
Write them to the user's requested repository-relative directory, defaulting to
descriptive paths under `test-results/`, such as
`test-results/<journey>-before.png` and
`test-results/<journey>-after.png`. Do not place credentials, pairing
instructions or tickets, configuration files, or other secrets in a screenshot
or artifact. Retain the PNG files after stopping local processes and removing
the private runtime snapshot; cleanup must never remove verification artifacts
from the checkout's `test-results/` directory. Report every repository-relative
artifact path. Do not create or redeem an identity transfer for preview work.

## Return the local app

When no preview was requested, return the exact clickable `$CHAT_ORIGIN` URL and
the ready record's Bot ID and workspace. Mention that Chat works only while the
local app and paired Runtime remain online. When a preview was requested, return
the captured artifact paths and the local app URL. Never expose the pairing URL,
ticket, saved credentials, or configuration files.

If pairing returns a typed error or does not become ready within five minutes,
report the error instead of returning the unpaired homepage URL.
