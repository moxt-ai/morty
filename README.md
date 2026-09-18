# Mobius Cloud

[![CI](https://github.com/moxt-ai/mobius-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/moxt-ai/mobius-chat/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/moxt-ai/mobius-chat/branch/main/graph/badge.svg)](https://codecov.io/gh/moxt-ai/mobius-chat)

CI runs `pnpm ci:check` for complete static verification and test coverage. Do not run it locally; use `pnpm lint`, `pnpm typecheck`, and related test cases instead.
Coverage reports a 95% advisory target across lines, statements, functions, and
branches; missing coverage is visible but does not fail the build. See
[Testing](TESTING.md) for scope and commands.

Mobius Cloud is one web application and one Cloudflare Worker. Clerk authenticates
individual users; Clerk Organizations and Cloud workspaces are not used. A signed-in
user can create or select a Mobius bot, chat with it, and connect it to Slack.

Mobius runs as a separate HTTP service. Management records Clerk user-to-bot ownership
in D1. Chat issues revocable, bot-scoped access tokens so the browser can communicate
directly with Mobius, while Cloud records each user's chat-session index.

## Repository layout

```text
packages/
  web/                         # React application and package-owned tests
  worker/
    migrations/0001_initial.sql # Single Cloud D1 schema
    src/components/chat/       # Access-token and chat-session APIs
    src/components/management/ # Clerk authentication and owned-bot management
    src/components/slack/      # Slack domain, HTTP, queue, D1, R2, and DO code
    src/gateway/               # Request dispatch and all external gateways
```

The pinned Mobius source under `third-party/mobius` supplies the protocol, SDK, and
local end-to-end stack. Each deployment environment uses regional Chat databases and
attachment buckets plus one Slack database and attachment bucket.

## Development

Requires Node.js 24.20.0 and pnpm 11.25.0.

```sh
pnpm install
pnpm exec wrangler d1 migrations apply DATABASE --local
pnpm dev
pnpm lint
pnpm typecheck
```

Copy `.dev.vars.example` to `.dev.vars` and configure Clerk. Configure
`MOBIUS_BASE_URL`, `MOBIUS_APP_ID`, and `MOBIUS_APP_SECRET` for the external Mobius
service. HTTPS is required except for loopback development. Mobius must allow the web
origin because browser chat traffic goes directly to it. Configure the same public
values as `VITE_MOBIUS_APP_ID` and `VITE_MOBIUS_BASE_URL` in the web build.
