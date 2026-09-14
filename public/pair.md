---
name: mobius-chat-pair
description: Connect this agent to the existing user and Bot from a Mobius Chat web page.
---

# Pair Mobius Chat

The user supplied `follow <origin>/pair.md?token=...`. That token is a one-use
ticket, valid for **24 hours**, for their existing user, Bot, and Project.
Fetching this document does not consume it. Do not create another user or Bot.

## Run

1. Set `BASE_URL` to this document's origin. Use `DOCUMENT_DIR` from the environment
   if provided; otherwise resolve the user's absolute document directory. Ask if
   unavailable; do not use a repository directory as a substitute.
2. Ensure Node.js 22.13.0 or newer, npm, and npx are available. Check their versions
   and install or repair missing dependencies using the host's normal tools.
3. Download `/setup.mjs` from the same origin to a private local directory, with a
   finite timeout and no redirects. Inspect it before running.
4. Set `TOKEN` from the supplied URL. Set `HARNESS` to **your own harness ID**:
   `codex` when running in Codex, `claude` in Claude Code, or `opencode` in OpenCode.
   Honor an explicit user choice instead. Do not ask the user to choose when your
   own harness is available. Complete its installation/authentication if needed.

```sh
node "$SCRIPT_DIR/setup.mjs" pair --token "$TOKEN" --harness "$HARNESS"
```

This single command stops existing Mobius Runtime processes owned by the current
OS user, exchanges the ticket, saves private credentials, launches a detached
Runtime, waits for the requested harness, requests its Bot binding, and checks
readiness. The Runtime remains running after your agent session ends.

## Observe and finish

The script streams timestamped JSON progress, including its Runtime PID and private
log path. It waits at most five minutes. Complete local Runtime approval if needed.
`runtime_started` or `binding_requested` is progress; only `status: "ready"` confirms
an active binding and online Runtime. A successful chat reply is a separate check.

When ready, tell the user: **Your Bot is connected. Return to your Mobius Chat page
to start chatting. Keep the Runtime online.** Include the returned URL and Bot ID.

On failure, use `error.code` and the private Runtime log to resolve the problem,
then rerun the same command. Saved identity and pairing progress are retained.
`HARNESS_UNAVAILABLE` reports the advertised alternatives; repair authentication or
ask the user before selecting a different harness. Expired or consumed tickets with
no saved local redemption require a fresh web instruction. `IDENTITY_CONFLICT`
preserves the existing config and redeemed credential in `pairing-recovery.json`;
resolve the conflict with the user. Never silently replace their identity.

Durable credentials belong only in `$DOCUMENT_DIR/mobius-chat/config.json`, not
command arguments, URLs, chat output, or logs. The CLI `--token` accepts only the
one-time ticket. Never generate a browser identity-transfer link in this flow.
