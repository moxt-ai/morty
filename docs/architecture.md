# Architecture

Mobius Cloud consists of `packages/web` and `packages/worker`.

The web package presents a user-owned bot flow: manage bots, chat, and connect Slack.
Visitors receive a browser-persisted anonymous credential and can manage bots and Chat
without signing in. Clerk supplies an optional user session for account binding and
Slack, but no organization or workspace authority.

The Worker groups code by component:

```text
request -> gateway -> cloud (anonymous or Clerk user auth)
                   -> chat (external Mobius HTTP)
                   -> slack (HTTP, queue, D1, R2, rate-limit DO)
```

All gateway implementations live in `packages/worker/src/gateway`; component
directories contain only their domain, service, HTTP, storage, and composition code.

Anonymous credentials and Clerk sessions resolve to one internal user ID. Raw
anonymous credentials are never stored server-side. Device transfer URLs carry a
separate 15-minute, one-use code in the URL fragment; redeeming it issues another
credential for the same internal user.

One Cloud D1 and one Cloud R2 bucket serve the Slack component. Mobius remains an
external service and owns its authorization and persistence. Cloud forwards only
allowlisted headers and preserves cancellation, deadlines, streams, and upgrades.

Run `pnpm check` to verify type safety, build output, linting, HTTP scenarios, browser
journeys, coverage, and dependency boundaries.
