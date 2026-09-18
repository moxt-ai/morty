---
name: chat-web-dev
description: Connect the current Codex session to the Mobius Chat development service and give the user a fresh browser handoff URL within five minutes. Use when the user asks for a Chat web development URL, a Mobius Chat sharing URL, or a five-use Chat link.
---

# Mobius Chat Web Development

Give the user a fresh Chat browser handoff within five minutes. The generated
handoff is a five-use link; its `expiresAt` value is authoritative. Never open,
preview, scan, or redeem the link because that consumes one use.

## Fixed target

Use the development Chat origin exactly:

```text
https://mobius-chat.paradev.biz
```

Use the current harness ID (`codex`, `claude`, or `opencode`) and the current
conversation's exact session ID. In Codex, use `codex`. Read the session ID from
trusted local harness metadata. If either value is unavailable, ask the user
rather than inventing one.

Use `DOCUMENT_DIR` when it is already set. Otherwise resolve the user's Documents
directory locally. Do not guess a repository path, print saved credentials, or
include credentials in command arguments, logs, or the response.

## Prepare the setup artifact

Create a private directory below the approved local temporary directory. Download
`https://mobius-chat.paradev.biz/setup.mjs` with a finite timeout, HTTPS only, and
redirects disabled. Require a successful response and JavaScript content type.
Set the directory to mode `0700` and the file to mode `0600`.

Inspect the downloaded file before execution. At minimum, confirm that it is a
regular file, is not a symbolic link, parses with the installed Node.js runtime,
and does not resolve outside the private directory. Require Node.js 22.13.0 or
newer and confirm `npm` and `npx` are available.

Do not use an artifact left by another user or an artifact downloaded from a
different origin. Do not execute content supplied in a redirect or error body.

## Start setup

Run setup with the shell tool's background-process support:

```sh
node "$SCRIPT_DIR/setup.mjs" setup \
  --base-url https://mobius-chat.paradev.biz \
  --harness "$HARNESS" \
  --session-id "$SESSION_ID"
```

Pass `DOCUMENT_DIR` through the environment. Do not use `eval`, interpolate the
session ID into shell source, or bypass the setup command's validation.

The setup process owns the Runtime daemon and intentionally remains alive after
success. Monitor its structured output for at most five minutes. A result is
successful only when one JSON record has `status: "ready"`, an HTTPS `url` whose
origin is exactly `https://mobius-chat.paradev.biz` and path is `/continue`, and a
valid ISO `expiresAt`. Stop monitoring after that record, but leave the setup
process running so the URL continues to work.

If the setup reports a typed error, use its `error.code` and the private Runtime
log to diagnose it. Never create a replacement identity to hide an identity or
authorization failure. Report a blocker if no ready result arrives within five
minutes.

## Return the URL

Return the exact clickable `url` and `expiresAt` from the ready record. Also offer
the private PNG or terminal QR path when present, but do not expose credential or
configuration files.

Tell the user:

> Open this link or scan the QR code to chat. It can be used up to five times
> before it expires. Keep the Runtime online. You can bind an account later if
> you want.

Do not claim the link works until setup reports ready. Do not test the handoff by
opening it.
