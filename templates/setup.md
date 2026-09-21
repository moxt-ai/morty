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
creates an identity if none is available. It first reconnects a matching saved Runtime
when Platform confirms its pairing is active; otherwise it creates a fresh Runtime.
The previous file is backed up, and the selected Runtime state is saved with the identity to `config.json`.
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
4. Set `HARNESS` to your own harness ID: `codex`, `claude`, `opencode`, or
   `oh-my-pi`. Set
   `SESSION_ID` to this current harness session's exact ID. Both values are required.
   Honor an explicit user choice instead. Complete that harness's installation and
   authentication if needed; do not ask the user to choose when your own harness is available.
5. Run the command from the user's current working directory. The script resolves and
   validates `$PWD`, then uses it as the paired Runtime's default Mobius Chat workspace.

Start this command with your harness's background execution support, then poll its
output every five seconds until it reports `status: "ready"` or an error. A successful
invocation intentionally never completes on its own: the script owns the Runtime daemon
and must remain running to keep that daemon alive. After `status: "ready"`, stop polling
but leave the background process running. Do not wait for it to exit, which would block
forever while the Runtime is online, and do not terminate it, which would stop the
Runtime. Closing this conversation stops the Runtime it started.

```sh
node "$SCRIPT_DIR/setup.mjs" setup --base-url "$BASE_URL" --cwd "$PWD" --harness "$HARNESS" --session-id "$SESSION_ID"
```

The command handles identity, Runtime pairing, Runtime launch, Bot binding, and
readiness. The selected Runtime uses the command's current working directory and stays attached to this
agent session; it exits when your session ends. It does not stop any other local
Mobius Runtime process. No separate prepare, bind, or finish commands are needed.

## Observe and finish

The script streams timestamped JSON progress and reports the Runtime PID and private
log path. Waits are cancellable and bounded to five minutes. Only `status: "ready"`
means the binding is active and the selected Runtime/agent is online; it does not
claim a successful test message.

Return the exact clickable browser `url`, resolved `workspace`, QR code, and `expiresAt` from the ready result.
The QR payload is the exact same URL, and the ready result provides both QR forms:
a terminal-safe QR code in the private text file at `qrTextPath` and an owner-only PNG
at `qrPath`. In a TUI, read `qrTextPath` and show its contents in a plain-text block
without changing the spacing. Choose the PNG instead only when the client reliably
displays local images. If you show the PNG, tell the user that a text QR is also
available and can be shown in the TUI if needed; read and render `qrTextPath` when they
need it or when the image cannot be displayed. The link identifies this harness session
so Chat can import it and open it after the handoff. The link is valid for **24 hours**, can be successfully
opened at most **five times**, and opens the same user and Bot each time. Never open,
preview, scan, or redeem it yourself because doing so consumes one use. Tell the user:
**Open this link or scan the QR code to chat. It can be used up to five times before it
expires. Keep the Runtime online. You can bind an account later if you want.**

On failure, use `error.code` and the private Runtime log, fix the problem, and rerun
the same command. It reuses the saved user identity and reconnects its active Runtime when possible. Preserve `$DOCUMENT_DIR/mobius-chat`
credentials on network errors, cancellation, and timeouts. An unavailable identity
requires user resolution; creating another user does not recover conversations.
Existing configuration is backed up to `config-backup-<id>.json` automatically.
Report the backup path from `configuration_backed_up` when replacement occurs.
If `SETUP_BUSY` persists, confirm the previous setup process exited before removing
its stale `.setup-lock` directory. Rerun for an expired/revoked Runtime pairing;
the script replaces its saved connection state. Never print the config or expose durable credentials in
arguments, URLs, logs, or chat. Rerun this command to obtain a fresh browser handoff.
