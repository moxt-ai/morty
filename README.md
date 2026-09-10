# Mobius Cloud

Mobius Cloud is one web application and one Cloudflare Worker. Clerk authenticates
individual users; Clerk Organizations and Cloud workspaces are not used. A signed-in
user can create or select a Mobius bot, chat with it, and connect it to Slack.

Mobius runs as a separate HTTP service. Cloud forwards `/mobius/api/*` requests and
their bearer credentials to `MOBIUS_BASE_URL`; the service owns bot authorization,
execution, persistence, and relay lifecycles.

## Repository layout

```text
packages/
  web/                         # React application
    src/cloud/                 # User bot management and application navigation
    src/mobius/                # Chat UI, HTTP/event client, and protocol codecs
    src/slack/                 # Slack management UI
  worker/
    migrations/0001_initial.sql # Single Cloud D1 schema
    src/components/chat/       # Chat request composition
    src/components/cloud/      # Clerk user authentication
    src/components/slack/      # Slack domain, HTTP, queue, D1, R2, and DO code
    src/gateway/               # Request dispatch and all external gateways
```

There are no Git submodules, `apps/` packages, storage shards, or standalone Slack
database. Each deployment environment uses one `DATABASE` D1 binding and one
`ATTACHMENTS` R2 binding.

## Development

Requires Node.js 24.20.0 and pnpm 11.25.0.

```sh
pnpm install
pnpm exec wrangler d1 migrations apply DATABASE --local
pnpm dev
pnpm check
```

Copy `.dev.vars.example` to `.dev.vars` and configure Clerk. Configure
`MOBIUS_BASE_URL` with an external Mobius origin. HTTPS is required except for
loopback development; recursive, credentialed, pathful, and redirecting targets
are rejected. Browser cookies are never forwarded upstream.
