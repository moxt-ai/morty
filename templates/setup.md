---
name: mobius-chat-setup
description: Set up Mobius Chat from an externally shared instruction and return a browser handoff.
---

# Set up Mobius Chat

This is the standalone entry for testing and external sharing, such as Twitter.
Reuse the user's saved identity or create an anonymous identity and personal Bot.
No Clerk registration is required. Web-generated instructions use `/pair.md?token=...`.
Only setup loads local configuration before connecting. It reuses the saved user
token and Bot selection for this origin, including an identity saved by pair, or
creates an identity if none is available. The previous file is backed up; fresh
Runtime pairing and binding state are saved with the identity to `config.json`.
Configuration from another environment is backed up and replaced for this origin.
Do not ask for an additional replacement confirmation.

## Run

1. Use the server-provided Chat origin exactly: `BASE_URL="{{BASE_URL}}"`.
   The script calls the Chat API at `{{BASE_URL}}/mobius-cloud/api/*`.
   The server supplies the Runtime URL separately as `pairing.relayUrl`.

   Use `DOCUMENT_DIR` from the environment if provided; otherwise resolve the user's
   absolute document directory and ask if unavailable. Never guess a repository path.
2. Ensure Node.js 22.13.0 or newer, npm, and npx are available. Check their versions
   and install or repair missing dependencies using the host's normal tools.
3. Download `{{BASE_URL}}/setup.mjs` into a private local directory, with
   finite timeouts and no redirects. Inspect it before running.
4. Set `HARNESS` to your own harness ID: `codex`, `claude`, or `opencode`. Honor an
   explicit user choice instead. Complete that harness's installation/authentication
   if needed; do not ask the user to choose when your own harness is available.

Run this command in the background so it keeps running after this reply. Closing
this conversation stops the Runtime it started.

```sh
node "$SCRIPT_DIR/setup.mjs" setup --base-url "$BASE_URL" --harness "$HARNESS"
```

The command handles identity, Runtime pairing, Runtime launch, Bot binding, and
readiness. The new Runtime uses `~/.mobius/workspace` and stays attached to this
agent session; it exits when your session ends. It does not stop any other local
Mobius Runtime process. No separate prepare, bind, or finish commands are needed.

## Observe and finish

The script streams timestamped JSON progress and reports the Runtime PID and private
log path. Waits are cancellable and bounded to five minutes. Complete any required
local Runtime approval. Only `status: "ready"` means the binding is active and the
selected Runtime/agent is online; it does not claim a successful test message.

Return the exact browser `url` and `expiresAt` from the ready result. The link is
valid for **24 hours**, can be successfully opened at most **five times**, and opens
the same user and Bot each time. Never open, preview, or redeem it yourself because
doing so consumes one use. Tell the user: **Open this link to chat. It can be used
up to five times before it expires. Keep the Runtime online. You can bind an account
later if you want.**

On failure, use `error.code` and the private Runtime log, fix the problem, and rerun
the same command. It reuses the saved user identity and starts Runtime pairing fresh. Preserve `$DOCUMENT_DIR/mobius-chat`
credentials on network errors, cancellation, and timeouts. An unavailable identity
requires user resolution; creating another user does not recover conversations.
Existing configuration is backed up to `config-backup-<id>.json` automatically.
Report the backup path from `configuration_backed_up` when replacement occurs.
If `SETUP_BUSY` persists, confirm the previous setup process exited before removing
its stale `.setup-lock` directory. Rerun for an expired/revoked Runtime pairing;
the script replaces its saved connection state. Never print the config or expose durable credentials in
arguments, URLs, logs, or chat. Rerun this command to obtain a fresh browser handoff.
