# Mobius Cloud

Cloud provides workspace management, Chat, and Slack integration in one web
application. Clerk owns workspace membership. Mobius runs as a separate service;
Cloud reaches its APIs through an HTTP gateway.

## Repository layout

```text
packages/
  web/                 # One React application
    src/cloud/         # Workspace and project/bot management
    src/mobius/        # Copied Mobius Chat UI
    src/slack/         # Slack management UI
  worker/src/          # Cloud Worker, identity, Slack composition, HTTP gateways
apps/
  slack/               # Normal tracked Slack backend, adapters, and migrations
  workflow/            # Independent Git submodule
```

Slack is part of this repository. Mobius is not a Git submodule or an embedded
server dependency. The copied frontend, HTTP/event client, and protocol codecs
are maintained under `packages/web/src/mobius`; they are not separate packages.

## Development

Requires Node.js 24.20.0 and pnpm 11.25.0.

```sh
pnpm install
pnpm dev
pnpm check
```

Copy `.dev.vars.example` to `.dev.vars` and configure Clerk. Set
`MOBIUS_BASE_URL` to the external Mobius service origin when it is available.
HTTPS is required except for loopback HTTP development services. The origin
must not point back to Cloud and must not include credentials, a path, or a
query string. Until configured, Mobius requests return `MOBIUS_UNAVAILABLE`.

## Requests and ownership

- `/mobius-cloud/api/*`: Cloud identity and workspace operations.
- `/mobius-slack/api/*`: The inlined Slack backend.
- `/mobius/api/*`: Forwarded to `MOBIUS_BASE_URL`, preserving the API path and
  query. The external service owns Mobius execution, persistence, and tenant
  authorization.

The gateway forwards existing bearer credentials; it does not invent tenant
authority, forward browser cookies, or follow upstream redirects. The Mobius
service must support the deployed client API and verify the credentials Cloud
users and connectors supply. HTTP response bodies and event streams pass
through with cancellation and deadlines. WebSocket upgrades are passed to the
service using the Workers fetch API.

Cloud owns Slack's D1/R2 placement and migrations. Mobius storage, relay Durable
Objects, and migrations are no longer deployed by Cloud. The Worker migration
removes the old Mobius Durable Object classes; existing Mobius data must be
migrated to the service before deploying this transition to an installation
that needs to retain it.

See [DEVELOPMENT.md](DEVELOPMENT.md) and [TESTING.md](TESTING.md) for local
development and acceptance-test guidance. Live Mobius verification requires a
configured upstream; gateway tests use a stateful service over a real HTTP socket.
