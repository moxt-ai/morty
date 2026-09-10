# Development

## Product boundary

Clerk verifies a user session only. The application does not read Clerk Organization
claims and has no workspace creation, membership, placement, or shard logic. The
verified Clerk user ID scopes Slack records and browser-local Mobius credentials.

Users manage their Mobius bots on `/`, open Chat on `/chat`, and manage Slack on
`/slack`. The web application sends Clerk bearer tokens to Cloud. Cloud forwards
Mobius API requests to the configured external service, which must independently
authorize the user and bot.

## Worker structure

Feature logic stays below `packages/worker/src/components`:

- `cloud`: Clerk configuration, token verification, and `/mobius-cloud/api`.
- `chat`: safe forwarding for `/mobius/api/*`.
- `slack`: Slack HTTP routes, services, queue processing, D1/R2 adapters, and rate limiting.

All external gateways and top-level request dispatch stay directly under
`packages/worker/src/gateway`; components do not contain gateway directories.

Slack is source code in the Worker package, not an embedded package or standalone
deployment. Shared runtime helpers remain directly under `packages/worker/src/infra`.

## Storage

Every environment binds one D1 database as `DATABASE` and one R2 bucket as
`ATTACHMENTS`. The Cloud-owned schema is `packages/worker/migrations/0001_initial.sql`.
Apply it locally with:

```sh
pnpm exec wrangler d1 migrations apply DATABASE --local
```

Staging and production resources are named in `wrangler.jsonc`. Apply remote
migrations with the matching Wrangler environment.

## External Mobius

`MOBIUS_BASE_URL` must be an HTTP loopback origin for local development or an HTTPS
origin elsewhere. It cannot contain credentials, a path, query, fragment, or Cloud's
own origin. `MOBIUS_APP_ID` and `MOBIUS_APP_SECRET` authenticate Worker operations.
The chat API issues and revokes bot-scoped access tokens; the browser uses those tokens
to communicate directly with Mobius. Slack's `MobiusGateway` also calls Mobius
directly and rejects recursive configuration and redirects.

## Verification

Run `pnpm check`. Product behavior is covered at HTTP and browser boundaries; tests
use deterministic time and stateful fakes rather than request mocks.
