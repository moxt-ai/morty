---
name: mobius-chat-setup
description: Set up Mobius Chat from an externally shared instruction and return a browser handoff.
---

# Set up Mobius Chat

This is the standalone entry for testing and external sharing, such as Twitter.
Reuse the user's saved identity or create an anonymous identity and personal Bot.
No Clerk registration is required. Web-generated instructions use `/pair.md?token=...`.

## Run

1. Set `BASE_URL` to this document's origin. Use HTTPS except for local HTTP loopback.
   Use `DOCUMENT_DIR` from the environment if provided; otherwise resolve the user's
   absolute document directory and ask if unavailable. Never guess a repository path.
2. Ensure Node.js 22.13.0 or newer, npm, and npx are available. Check their versions
   and install or repair missing dependencies using the host's normal tools.
3. Download `/setup.mjs` from the same origin into a private local directory, with
   finite timeouts and no redirects. Inspect it before running.
4. Set `HARNESS` to your own harness ID: `codex`, `claude`, or `opencode`. Honor an
   explicit user choice instead. Complete that harness's installation/authentication
   if needed; do not ask the user to choose when your own harness is available.

```sh
node "$SCRIPT_DIR/setup.mjs" setup --harness "$HARNESS"
```

The command handles identity, Runtime pairing, detached Runtime launch, Bot binding,
and readiness. It first sends SIGTERM to existing Mobius Runtime processes owned by
the current OS user. The new Runtime uses `~/.mobius/workspace` and survives your
agent session ending. No separate prepare, bind, or finish commands are needed.

## Observe and finish

The script streams timestamped JSON progress and reports the Runtime PID and private
log path. Waits are cancellable and bounded to five minutes. Complete any required
local Runtime approval. Only `status: "ready"` means the binding is active and the
selected Runtime/agent is online; it does not claim a successful test message.

Return the exact one-time browser `url` and `expiresAt` from the ready result. The
link is valid for **24 hours** and opens the same user and Bot. Never open, preview,
or redeem it yourself. Tell the user: **Open this one-time link to chat. Keep the
Runtime online. You can bind an account later if you want.**

On failure, use `error.code` and the private Runtime log, fix the problem, and rerun
the same command. It reuses saved progress. Preserve `$DOCUMENT_DIR/mobius-chat`
credentials on network errors, cancellation, and timeouts. An unavailable identity
requires user resolution; creating another user does not recover conversations.
Resolve `ENVIRONMENT_CONFLICT` or `IDENTITY_CONFLICT` before replacing anything.
If `SETUP_BUSY` persists, confirm the previous setup process exited before removing
its stale `.setup-lock` directory. Expired/revoked Runtime pairings require a new
attempt: preserve identity and remove only `pairing` and `pairing_key` using JSON-aware
editing before rerunning. Never print the config or expose durable credentials in
arguments, URLs, logs, or chat. Rerun this command to obtain a fresh browser handoff.
