---
name: web-dev
description: Serve the Morty SPA from this checkout with hot reload while the deployed Worker answers its Chat API and WebSocket bridge, then sign in with a continue link the user provides. Use when a designer wants to iterate on the browser UI against real data, or to diagnose this setup failing with WEBSOCKET_ORIGIN_FORBIDDEN, slow or resetting bridged connections, or "Morty is temporarily unavailable" on reload.
---

# Local Web Development Against the Deployed Worker

Serve the browser app from this checkout so edits under `packages/web/src`
hot-reload, while every `/morty/api` request and the `/morty/ws` bridge are
answered by the **deployed Worker**. The designer sees their real Project,
sessions, and connected Runtime while iterating on markup, styling, and
interaction.

What is local: the SPA modules and their edits, served by Vite. What is
remote: the deployed Worker origin (default `https://morty.build`), which owns
identity, sessions, and the WebSocket bridge. Nothing here deploys or mutates
the deployed Worker's configuration.

Use `chat-local-full-dev` when the Chat Worker and Platform must run locally,
and `agent-verify-user-journey` for a full generation-journey verification. This
skill needs no `.dev.vars`, no local Worker, and no Platform credential.

## Prerequisites

| Requirement | Detail |
| --- | --- |
| Checkout | This repository with `package.json`, `vite.config.ts` at its root; locked dependencies installed. |
| Toolchain | The pinned Node.js (>= 24) and pnpm from `package.json` `engines`. |
| Deployed origin | The Worker origin to proxy to. Default `https://morty.build`; use the origin the user names. |
| Continue URL | A `https://<deployed>/continue#code=…` link from the user for sign-in. The code is a one-time secret: never print, log, or commit it. |

Stop and ask if there is no continue link; do not invent credentials or redeem
links from any other source. A link without `harness`/`sessionId` parameters
redeems the identity and lands on the Chat page; one with them also imports that
native session and requires its Runtime to be online.

## Create the proxy configuration

The SPA sends every API call and the bridge WebSocket to its own origin, and the
deployed Worker rejects foreign origins, so a dev-server proxy must forward
both and rewrite the `Origin` header. Write this config to a gitignored path
under `.wrangler/` (create the directory; it is already ignored):

```sh
mkdir -p .wrangler/web-dev
```

Write `.wrangler/web-dev/vite.proxy.config.ts` with `<deployed-origin>` replaced:

```ts
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const deployed = "<deployed-origin>";
// Same-origin forwarding: the deployed Worker rejects requests whose Origin
// differs from its own, so the proxy rewrites it. The agent reuses Node's
// environment-aware global agent; without it the proxy dials the origin
// directly, which is slow or reset on proxy-dependent networks.
const forward = {
    target: deployed,
    changeOrigin: true,
    secure: true,
    headers: { origin: deployed },
    agent: (await import("node:https")).globalAgent,
};

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: [{ find: "@", replacement: fileURLToPath(new URL("../../packages/web/src", import.meta.url)) }],
    },
    server: {
        host: "localhost",
        port: 5173,
        strictPort: true,
        proxy: {
            "/morty/api": forward,
            "/morty/ws": { ...forward, ws: true },
        },
    },
});
```

Why each non-obvious part exists, from verified failures:

- `headers: { origin: deployed }` — without it the bridge upgrade fails and the
  page shows "The Chat WebSocket bridge could not connect"
  (`WEBSOCKET_ORIGIN_FORBIDDEN`).
- `agent: globalAgent` — the bundled `http-proxy` forces `agent: false` when
  unset, which **bypasses** the environment proxy and dials the origin
  directly. On networks where direct egress is slow or reset, WebSocket
  upgrades then take 4-30 s or die, the session load misses its 15 s deadline,
  and the page shows "Morty is temporarily unavailable".

## Start the dev server

Run with Node's environment-proxy support so `globalAgent` honors
`HTTPS_PROXY`/`HTTP_PROXY` when they are set:

```sh
NODE_OPTIONS=--use-env-proxy pnpm exec vite --config .wrangler/web-dev/vite.proxy.config.ts
```

Port 5173 is strict. If it is taken, stop the process that owns it rather than
reusing it: it may proxy a different deployed origin.

## Verify the topology before opening the app

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:5173/
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:5173/morty/api
```

Expect `200` for the SPA and `200` from the proxied deployed Worker. The second
request proves the proxy reaches the deployed origin; if it hangs or errors,
fix the proxy layer before touching the browser.

## Sign in with the continue link

Rewrite the user's continue URL to the local origin, keeping the hash intact,
without printing it. Given `https://morty.build/continue#code=…`, open:

```text
http://localhost:5173/continue#code=…
```

The Continue page redeems the transfer code through the proxy, stores the
identity, and lands on the Chat page with the user's real sessions. A code is
one-time: if redemption fails, ask the user for a fresh link rather than
retrying the spent one. Open the link in a fresh browser profile or session so
no other stored identity interferes.

## Iterate

Edits under `packages/web/src` hot-reload without losing the session. Capture
representative states under `test-results/` when the user asks for previews.
Only the SPA runs locally: conversations, sessions, and every API write happen
on the deployed origin, so treat generated content and session data as the
user's real data.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "The Chat WebSocket bridge could not connect" / `WEBSOCKET_ORIGIN_FORBIDDEN` | The proxy forwarded the browser's `Origin: http://localhost:5173` to the deployed Worker | Confirm `headers: { origin: deployed }` on both proxy entries |
| Bridge opens but takes many seconds, then "Morty is temporarily unavailable" | Direct (non-proxy) egress to the origin is slow or reset; the session load missed its 15 s deadline | Set `agent: globalAgent` in the config and start with `NODE_OPTIONS=--use-env-proxy` |
| "Morty is temporarily unavailable" on **every** reload with a signed-in identity | Dev entry still double-mounts components (StrictMode) that terminal-close the transport mid-load | Requires the application-root fix that renders without StrictMode |
| `503`/`502` from `/morty/api` through the proxy | Wrong `target` origin, or the deployed Worker is down | Verify the origin with `curl` directly, then fix `target` |
| Continue page rejects the code | The one-time code was already redeemed, or it expired | Ask the user for a fresh continue link |
| `Port 5173 is already in use` | Another dev server owns the port | Stop that process; it may target a different origin |

## Constraints

- Never deploy, publish, or mutate the deployed Worker from this flow.
- Treat the continue code and the redeemed identity as secrets: never print,
  screenshot, or commit them.
- Do not point the proxy at an origin the user did not name.

## Cleanup

Stop the dev server with Ctrl-C. The config under `.wrangler/web-dev/` is
gitignored and safe to keep for the next session. Browser evidence under
`test-results/` is retained.
