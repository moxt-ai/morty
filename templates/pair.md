---
name: morty-pair
description: Connect this agent to the existing user and Bot from a Morty web page.
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Pair Morty

The user supplied `follow <origin>/pair.md?token=...`. That token is a one-use
ticket, valid for **10 minutes**, for their existing user, Bot, and workspace.
Fetching this document does not consume it. Do not create another user or Bot.
Pairing takes its identity and Bot only from the supplied ticket. After redemption,
it fully validates the returned identity, Bot, workspace, and expected Runtime before
continuing. The verified Chat identity, Bot, and workspace are saved to `config.json`;
Mobius owns Runtime connection state and identifiers. Do not retain or back up App,
Runtime, Connection, Channel, or pairing identifiers, and do not ask for an additional
replacement confirmation.

## Run

1. Use the server-provided Chat origin exactly: `BASE_URL="{{BASE_URL}}"`.
   Assign shell variables before the command that expands them. Never use
   `BASE_URL=... node ... --base-url "$BASE_URL"`; the shell expands `BASE_URL`
   before that command-scoped assignment takes effect.
   The script calls the Chat API at `{{BASE_URL}}/morty/api/*`.
   The server supplies the Runtime URL separately as `pairing.relayUrl`.

   Use `DOCUMENT_DIR` from the environment if provided; otherwise resolve the user's
   absolute document directory. Ask if unavailable; do not use a repository directory
   as a substitute.
2. Ensure Node.js 22.13.0 or newer and npm are available. Install or update the
   persistent manager with `npm install --global @moxt-ai/mobius@latest`.
3. Download `{{BASE_URL}}/setup.mjs` to a private local directory, with a
   finite timeout and no redirects. Inspect it before running.
4. Set `TOKEN` from the supplied URL. Set `HARNESS` to **your own harness ID**:
   `codex` when running in Codex, `claude` in Claude Code, `opencode` in OpenCode,
   or `oh-my-pi` in Oh My Pi.
   Honor an explicit user choice instead. Do not ask the user to choose when your
   own harness is available. Complete its installation/authentication if needed.
5. Run the command from the user's current working directory. The script resolves and
   validates `$PWD`, then uses it as the paired Runtime's default Morty workspace.

Run this command normally. It registers the Runtime with the per-user Mobius manager,
which remains online after this command and the current conversation exit.

```sh
BASE_URL="{{BASE_URL}}"
SCRIPT_DIR="<private directory containing setup.mjs>"
TOKEN="<one-use token from the supplied URL>"
HARNESS="<codex, claude, opencode, or oh-my-pi>"
node "$SCRIPT_DIR/setup.mjs" pair --base-url "$BASE_URL" --cwd "$PWD" --token="$TOKEN" --harness "$HARNESS"
```

This single command exchanges the ticket, creates a fresh Runtime pairing for the
Project and Bot returned by that ticket and the current working directory, saves only
the private Chat identity and Bot configuration, and launches the Runtime through the
singleton local manager. After Runtime pairing reports
the requested harness, the script immediately requests
its Bot binding and checks readiness. It does not list or reuse managed Runtime
connections; those remain online. The setup configuration does not persist App, Runtime, Connection,
Channel, or pairing identifiers.

## Observe and finish

The script streams timestamped JSON progress, including its Runtime PID and private
log path. It waits at most five minutes. `runtime_started` or `binding_activated` is
progress; only `status: "ready"` confirms
an active binding and online Runtime. A successful chat reply is a separate check.

When ready, tell the user: **Your Bot is connected. Return to your Morty page
to start chatting. Keep the Runtime online.** Include the returned URL, Bot ID, and workspace.

On failure, use `error.code` and the private Runtime log to resolve the problem.
If `identity_ready` was emitted, set `SESSION_ID` to this current harness session's
exact ID and reconnect using `node "$SCRIPT_DIR/setup.mjs" setup --base-url "$BASE_URL" --cwd "$PWD" --harness "$HARNESS" --session-id "$SESSION_ID"`.
Setup loads the saved user and Bot and starts Runtime
pairing fresh; its ready result includes a browser handoff as described in `/setup.md`.
`HARNESS_UNAVAILABLE` reports the advertised alternatives; repair authentication or
ask the user before selecting a different harness. Pair always redeems its ticket;
an expired or consumed ticket requires a fresh web instruction to run pair again.

Durable credentials belong only in private files under `$DOCUMENT_DIR/morty`, not
command arguments, URLs, chat output, or logs. The CLI `--token` accepts only the
one-time ticket. Never generate a browser identity-transfer link in this flow.
