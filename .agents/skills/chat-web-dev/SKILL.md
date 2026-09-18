---
name: chat-web-dev
description: Start the current Mobius Chat checkout locally and give the user a localhost URL that remains available for five minutes. Use when the user asks to run, open, preview, or test the Chat web app locally.
---

# Mobius Chat Web Development

Start the current checkout's local web development server and give the user its
loopback URL. Keep it running for five minutes, then let the harness terminate it.
Do not create a remote tunnel, transfer link, anonymous handoff, Runtime pairing,
or deployment.

## Validate the checkout

Resolve the repository root with `git rev-parse --show-toplevel` and use that
absolute path as the working directory for every command. Confirm that the root
contains `package.json`, `vite.config.ts`, and `wrangler.jsonc`.

Inspect `git status --short` without modifying or discarding user changes. This
skill may start the development server, but it does not authorize commits,
dependency upgrades, configuration edits, or cleanup of unrelated processes.

Require the repository's pinned Node.js and pnpm versions. Install locked
dependencies with `pnpm install --frozen-lockfile` only when they are missing or
out of date. If the Mobius submodule has missing locked dependencies, run the
same command inside `third-party/mobius`.

## Reserve the local URL

Use the Vite configuration's fixed loopback URL:

```text
http://localhost:5173/
```

Before starting, check whether port 5173 is listening. If it is already owned by
this checkout's healthy `pnpm dev` process, reuse it. If another process owns the
port, do not stop or replace that process; report the conflict.

## Start for five minutes

Run this command with the harness's background execution support and a 300-second
process timeout:

```sh
pnpm dev
```

Do not detach a child outside the harness lifecycle. The process must be owned by
the background command so the five-minute timeout releases the server and port.

Wait for the startup output to report the local server URL. Then make one bounded
HTTP request to `http://localhost:5173/`. Success requires an HTTP 200 response
from the local server. Do not claim readiness based only on an open port.

If startup or the readiness request fails, report the error and do not return a
URL. Do not retry indefinitely; the whole workflow must remain bounded by five
minutes.

## Return the URL

Return this exact clickable URL:

```text
http://localhost:5173/
```

Tell the user that it is local to their machine and remains available for five
minutes from startup. Do not open the URL yourself unless the user also requests
browser verification.
