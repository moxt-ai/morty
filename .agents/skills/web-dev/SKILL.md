---
name: web-dev
description: Run the Morty web app and its Chat Worker locally against the production Mobius Platform so a designer can iterate on the browser UI with hot reload. Use when the user asks to run Morty web locally, preview UI changes, point a local checkout at production Mobius, or diagnose a local page that fails with PLATFORM_UNAVAILABLE, PLATFORM_APP_UNAUTHORIZED, or SETUP_ARTIFACT_UNAVAILABLE.
---

# Local Web Development Against Production Mobius

Run the browser app from this checkout with hot reload while its Chat Worker talks
to the production Mobius Platform. A designer can then change UI and see the
result immediately against real Projects, Runtimes and relays.

What stays local: the Chat Worker, its Durable Objects, D1 and R2 persistence
under `.wrangler/`. What is remote: the production Mobius Platform at
`https://mobius.moxt.ai`, which owns Projects, Bots, Runtime pairings and
session relays. Nothing in this flow deploys, publishes or mutates deployed
configuration.

This skill is for interface work against real Platform behaviour. Use
`chat-local-full-dev` when the Platform itself must run locally, and
`agent-verify-user-journey` when the deliverable is a verified user journey.

## What you need

| Requirement | Detail |
| --- | --- |
| Checkout | This repository, with `package.json`, `vite.config.ts` and `wrangler.jsonc` at its root. |
| Toolchain | The pinned Node.js (>= 24) and pnpm from `package.json` `engines`. Install locked dependencies when missing; never upgrade them. |
| Production Platform credential | A production Mobius App ID and its full `mapp_…` AppCredential, issued by the production Platform Console, whose App may provision Projects. |

Ask the owner for the credential; never invent it, never copy a deployed Worker
secret, and never provision a new production App for this flow. Treat it as a
local-only secret.

Credentials are environment-specific. A credential issued by the staging or a
local Platform authenticates nowhere against production and fails with
`project_credential_invalid`, so confirm which Platform issued the value before
debugging anything else.

## Configure the local Worker

`.dev.vars` is gitignored and is the only place these values belong. Start from
the committed template:

```sh
cp .dev.vars.example .dev.vars
chmod 600 .dev.vars
```

Set these keys. The Worker reads them through Cloudflare's Vite plugin, which
reports `Using secrets defined in .dev.vars` on startup.

| Key | Value |
| --- | --- |
| `APP_ORIGIN` | `http://localhost:5173` |
| `AUTHENTICATION_BASE_URL` | `http://localhost:5173` |
| `MOBIUS_BASE_URL` | `https://mobius.moxt.ai` |
| `MOBIUS_APP_ID` | The production App ID, `app_…` |
| `MOBIUS_APP_SECRET` | The full production AppCredential, `mapp_…` |

The anonymous identity flow that drives local UI work does not use Clerk, so the
template's `CLERK_PUBLISHABLE_KEY` and `CLERK_JWT_KEY` values can stay as they
are until someone exercises Clerk-backed sign-in. Only that path needs a real
publishable key and its matching PEM **public** verification key.

`MOBIUS_BASE_URL` must be an `https` origin with no path, credentials, query or
fragment, and it must not equal the `APP_ORIGIN` origin. The Worker rejects
anything else and reports `PLATFORM_UNAVAILABLE`.

The AppCredential decides whether the app can provision Projects on the
production Platform. It must be an App-wide server credential for an App in that
Platform: either a credential that is not issued there, or one limited to
selected Projects, fails on the first anonymous visit.

## Seed the setup artifact

The Worker serves `/setup.mjs` from local R2. Seed it once per local persistence
state, after any change to the setup package:

```sh
pnpm build:setup
pnpm exec wrangler r2 object put morty-local-apac-attachments/artifacts/setup.mjs \
  --file packages/setup/dist/setup.mjs --local
```

Skipping this leaves `/setup.mjs` returning `503 SETUP_ARTIFACT_UNAVAILABLE`,
which stops an agent from connecting even though the page loads.

## Start the app

```sh
pnpm dev
```

Vite and the Cloudflare plugin start the SPA and the Chat Worker together. Wait
for `Local: http://localhost:5173/`. Port 5173 is strict: if it is already taken,
stop the process that owns it rather than reusing it, because that process may
hold different Platform credentials.

## Verify the production connection

Run these in order; the last one is the only check that proves the Worker reached
the production Platform.

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:5173/
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:5173/setup.md
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:5173/setup.mjs
curl -sS -X POST http://localhost:5173/morty/api/identity/anonymous-users \
  -H 'content-type: application/json' -d '{}'
```

Expect `200`, `200`, `200`, then a `201` body carrying `projectId`, `bot.botId`
and a `token`. That last request is the only proof: it asks the local Worker to
provision a real Project on the production Platform, so a success means the
credential, origin and Platform endpoint all agree. It also creates one Project
and one anonymous user, so run it deliberately rather than on a loop. The token
and the Project ID are secrets: confirm the shape and never print or store them.

## Use the app

Open `http://localhost:5173/`. A fresh browser shows **Connect your local
agent**, because anonymous identity is created by the setup flow rather than by
page load. UI iteration up to that point needs no agent: navigate, resize, and
exercise every visible state.

To exercise the signed-in experience, copy the instruction from that page into
the selected harness. The harness fetches `/setup.md`, runs `setup.mjs` against
this local origin, and returns a handoff link; open that link in the browser and
the Continue page lands on Chat. The Runtime, the agent and its working directory
stay on this machine even though the Platform is production.

## Iterate

Edits under `packages/web/src` hot-reload in the browser. Worker edits under
`packages/worker/src` restart the local Worker. Local Durable Objects, D1 and R2
live under `.wrangler/`, so this checkout's conversations, attachments and test
Projects never land in another checkout's local state.

Only the Platform control plane is shared. Projects, Bots and anonymous users the
local Worker creates do exist on the production Platform under the configured
App, so keep manual verification to the flows you actually need and do not run
generated load loops against it.

Because the page's runtime config is local, the app reads its Platform connection
from this Worker rather than from a build-time URL. The Cloudflare plugin watches
`.dev.vars` and restarts the Worker when it changes; if an edit does not take
effect, stop and start `pnpm dev` again.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `502 PLATFORM_APP_UNAUTHORIZED` "The Chat App is not authorized to provision Projects", caused by `401 project_credential_invalid` / "App authentication failed" | The AppCredential was issued by another Platform environment, was revoked, or is not an App-wide server credential for this App | Replace `MOBIUS_APP_ID` and `MOBIUS_APP_SECRET` with the production App's App-wide server credential |
| `503 PLATFORM_UNAVAILABLE` "Platform is not configured", or "Invalid Platform endpoint" in the Worker log | `MOBIUS_BASE_URL` is missing, has a path or query, is not `https`, or equals the `APP_ORIGIN` origin | Set it to exactly `https://mobius.moxt.ai` |
| `503 SETUP_ARTIFACT_UNAVAILABLE` on `/setup.mjs` | The artifact was never seeded for this `.wrangler/` state | Run the seed step above, then retry |
| Startup fails because `CLERK_PUBLISHABLE_KEY` or `CLERK_JWT_KEY` is invalid | The key pair is not a valid Clerk publishable key and public PEM | Use the matching pair for one Clerk instance |
| `Port 5173 is already in use` | Another checkout's dev server owns the port | Stop that process rather than reusing its credentials |
| Page loads but every request fails | The Worker restarted without `.dev.vars` | Confirm the startup log reports `Using secrets defined in .dev.vars` |

Branch on the sanitized error code from the page and the Worker log, never on
message text alone.

## Constraints

- Local and read-mostly. Never run `wrangler deploy`, `wrangler tail`, or any
  command that changes a Cloudflare account or the production Platform.
- Never commit `.dev.vars`, print its secret values, or copy a credential into a
  tracked file, screenshot, or chat message.
- Never reuse one checkout's credentials for another origin or checkout.
- Keep the production App credential out of the generated app and out of any
  captured evidence.

## Cleanup

Stop the dev server with Ctrl-C. Keep `.dev.vars` if you will return to this
checkout. Delete `.wrangler/` only when you want a clean local database; it is
gitignored and holds no production data.
