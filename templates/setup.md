---
name: morty-setup
description: Set up Morty from an externally shared instruction and return a browser handoff.
---

# Set up Morty

This is the standalone entry for testing and external sharing, such as Twitter.
Reuse the user's saved identity or create an anonymous identity and personal Bot.
No Clerk registration is required. Web-generated instructions use `/pair.md?token=...`.
Only setup loads local configuration before connecting. It reuses the saved user
token and Bot selection for this origin, including an identity saved by pair, or
creates an identity if none is available. It first reconnects a Mobius-managed
connection for the App when Platform confirms its pairing is active; otherwise it
creates a fresh Runtime pairing. Only Chat identity, Bot, handoff, and workspace
configuration is backed up or saved in `config.json`. Do not retain or back up App,
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
   absolute document directory and ask if unavailable. Never guess a repository path.
2. Ensure Node.js 22.13.0 or newer and npm are available. Install or update the
   persistent manager with `npm install --global @moxt-ai/mobius@latest`.
3. Download `{{BASE_URL}}/setup.mjs` into a private local directory, with
   finite timeouts and no redirects. Inspect it before running.
4. Set `HARNESS` to your own harness ID: `codex`, `claude`, `opencode`, or
   `oh-my-pi`. Set
   `SESSION_ID` to this current harness session's exact ID. Both values are required.
   Honor an explicit user choice instead. Complete that harness's installation and
   authentication if needed; do not ask the user to choose when your own harness is available.
5. Run the command from the user's current working directory. The script resolves and
   validates `$PWD`, then uses it as the paired Runtime's default Morty workspace.

Run this command normally and wait until it reports `status: "ready"` or an error.
The command exits after registering the Runtime with the per-user Mobius manager;
the manager and all paired Runtime connections remain online independently.

```sh
BASE_URL="{{BASE_URL}}"
SCRIPT_DIR="<private directory containing setup.mjs>"
HARNESS="<codex, claude, opencode, or oh-my-pi>"
SESSION_ID="<current harness session ID>"
node "$SCRIPT_DIR/setup.mjs" setup --base-url "$BASE_URL" --cwd "$PWD" --harness "$HARNESS" --session-id "$SESSION_ID"
```

The command handles identity, Runtime pairing, Runtime launch, Bot binding, and
readiness. The selected Runtime uses the command's current working directory and joins
the same singleton manager as every existing pairing. No separate prepare, bind, or
finish commands are needed.
It writes an empty private temporary JSON file and asks
`mobius pair list --output-json=<that-file>` for the current local connections. A
connection is reused when its App ID matches the Chat workspace, and its Runtime ID
comes from that local connection record. Otherwise the script creates a new pairing.
App, Runtime, Connection, Channel, and
pairing identifiers are not saved in the setup configuration.

## Observe and finish

The script streams timestamped JSON progress. Waits are cancellable and bounded to
five minutes. Only `status: "ready"`
means the binding is active and the selected Runtime/agent is online; it does not
claim a successful test message.

Return the exact clickable browser `url`, resolved `workspace`, and QR code from the ready result.
The QR payload is the exact same URL, and the ready result provides a browser-safe PNG
data URL at `qrDataUrl`, a terminal-safe QR code in the private text file at `qrTextPath`,
and an owner-only PNG at `qrPath`. In a browser chat that supports Markdown images, embed
`qrDataUrl` directly for a portable image, or embed `qrPath` when the chat renderer can
query Runtime files by path. In a TUI, read `qrTextPath` and show its contents in a plain-text block without
changing the spacing. Tell the user that the text QR is also available and can be shown
in the TUI if needed. The link identifies this harness session
so Chat can import it and open it after the handoff. The link can be successfully
opened at most **five times**, does not expire, and opens the same user and Bot each time. Never open,
preview, scan, or redeem it yourself because doing so consumes one use. Tell the user:
**Open this link or scan the QR code to chat. It can be used up to five times. Keep the
Runtime online. You can bind an account later if you want.**

On failure, use `error.code`, its sanitized `error.cause` chain, and the private
Runtime log. Fix the problem and rerun
the same command. It reuses the saved user identity and reconnects a Mobius-managed
connection for the App when possible. Preserve `$DOCUMENT_DIR/morty`
credentials on network errors, cancellation, and timeouts. An unavailable identity
requires user resolution; creating another user does not recover conversations.
If `SETUP_BUSY` persists, confirm the previous setup process exited before removing
its stale `.setup-lock` directory. Rerun for an expired/revoked Runtime pairing;
Mobius remains the owner of saved connection state. Never print the config or expose durable credentials in
arguments, URLs, logs, or chat. Rerun this command to obtain a fresh browser handoff.
