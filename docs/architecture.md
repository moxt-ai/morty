# Architecture

Mobius Cloud consists of `packages/web` and `packages/worker`.

The web package presents a user-owned bot flow: manage bots, chat, and connect Slack.
Clerk supplies the user session but no organization or workspace authority.

The Worker groups code by component:

```text
request -> gateway -> cloud (Clerk user auth)
                   -> chat (external Mobius HTTP)
                   -> slack (HTTP, queue, D1, R2, rate-limit DO)
```

One Cloud D1 and one Cloud R2 bucket serve the Slack component. Mobius remains an
external service and owns its authorization and persistence. Cloud forwards only
allowlisted headers and preserves cancellation, deadlines, streams, and upgrades.

Run `pnpm check` to verify type safety, build output, linting, HTTP scenarios, browser
journeys, coverage, and dependency boundaries.
