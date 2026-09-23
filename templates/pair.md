---
name: morty-pair
description: Connect this agent to the existing user and Bot from a Morty web page.
---

# Pair Morty

The user supplied `follow <origin>/pair.md?token=...`. That token is a one-use
ticket, valid for **10 minutes**, for their existing user, Bot, and workspace.
Fetching this document does not consume it. Do not create another user or Bot.
Pairing takes its identity and Bot only from the supplied ticket. After redemption,
it may reconnect saved Runtime state only when that state belongs to the exact same
Chat origin, user, workspace, and Bot, matches the Runtime selected by the ticket, and
Platform confirms that the pairing remains active. Otherwise it creates a fresh Runtime pairing. The previous file is backed up,
then the verified identity and Runtime connection state are saved to `config.json`.
Do not ask for an additional replacement confirmation.

## Run

1. Use the server-provided Chat origin exactly: `BASE_URL="{{BASE_URL}}"`.
   The script calls the Chat API at `{{BASE_URL}}/mobius-cloud/api/*`.
   The server supplies the Runtime URL separately as `pairing.relayUrl`.

   Use `DOCUMENT_DIR` from the environment if provided; otherwise resolve the user's
   absolute document directory. Ask if unavailable; do not use a repository directory
   as a substitute.
2. Ensure Node.js 22.13.0 or newer, npm, and npx are available. Check their versions
   and install or repair missing dependencies using the host's normal tools.
3. Download `{{BASE_URL}}/setup.mjs` to a private local directory, with a
   finite timeout and no redirects. Inspect it before running.
4. Set `TOKEN` from the supplied URL. Set `HARNESS` to **your own harness ID**:
   `codex` when running in Codex, `claude` in Claude Code, `opencode` in OpenCode,
   or `oh-my-pi` in Oh My Pi.
   Honor an explicit user choice instead. Do not ask the user to choose when your
   own harness is available. Complete its installation/authentication if needed.
5. Run the command from the user's current working directory. The script resolves and
   validates `$PWD`, then uses it as the paired Runtime's default Morty workspace.

Run this command in the background so it keeps running after this reply. Closing
this conversation stops the Runtime it started.

```sh
node "$SCRIPT_DIR/setup.mjs" pair --base-url "$BASE_URL" --cwd "$PWD" --token="$TOKEN" --harness "$HARNESS"
```

This single command exchanges the ticket, reconnects a matching saved Runtime or
creates a fresh pairing for the current working directory, saves private credentials,
and launches the Runtime attached to this agent session. After Runtime pairing reports
the requested harness, the script immediately requests
its Bot binding and checks readiness. It does not stop any other local Mobius
Runtime process. The Runtime exits when your agent session ends.

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
Previous configuration is preserved in `config-backup-<id>.json`.
Backup progress reports paths, never credentials. Report the backup path when a
replacement occurs.

Durable credentials belong only in private files under `$DOCUMENT_DIR/morty`, not
command arguments, URLs, chat output, or logs. The CLI `--token` accepts only the
one-time ticket. Never generate a browser identity-transfer link in this flow.
