# GitHub-managed Worker configuration

After this, an operator can update individual runtime variables and secrets in
GitHub and see them applied to Cloudflare by the next successful CD deployment.

Both `moxt-ai/morty` and `moxt-ai/mobius` use separate `staging` and
`production` GitHub Environments. Each runtime setting has its own GitHub name;
the workflows explicitly map those names to Worker bindings. Configuration is
validated by `scripts/validate-worker-config.ts` before migrations/deployment.
CI also runs this script against both GitHub Environments in separate matrix jobs
on same-repository pull requests, merge groups, main pushes, and manual runs.
Fork pull requests skip these environment-backed jobs because secrets are not
available to them. CD waits for successful configuration validation.

## Chat

Configure these **GitHub Environment variables** individually:

- `APP_ORIGIN` — canonical Chat origin, without a trailing slash.
- `AUTHENTICATION_BASE_URL` — application authentication base URL.
- `CLERK_PUBLISHABLE_KEY` — environment-specific Clerk publishable key.
- `CLERK_JWT_KEY` — multiline PEM **public verification key**, not a private key.
- `MOBIUS_BASE_URL` — Platform origin.
- `MOBIUS_APP_ID` — environment-specific Platform App ID.
- `SLACK_SERVER_BASE_URL` — Slack server URL.

Configure these **GitHub Environment secrets** individually:

- `MOBIUS_APP_SECRET` — full `mapp_…` AppCredential.
- `SLACK_MOBIUS_AUTH_TOKEN`.
- `SLACK_OAUTH_STATE_SIGNING_KEY`.
- `SLACK_TOKEN_ENCRYPTION_KEY`.

Retain the deployment secrets `CLOUDFLARE_API_TOKEN`, `MOBIUS_READ_TOKEN`, and
`SENTRY_AUTH_TOKEN`, and the variables `SENTRY_DSN`, `SENTRY_ORG`, and
`SENTRY_PROJECT`. These are CD/build settings, not Worker bindings.

CD assembles a private temporary JSON file from the individual runtime secrets
and uploads it with the Worker version using Wrangler's `--secrets-file`. The
file is removed when the deployment step exits. Multiline values are encoded by
the script; enter actual multiline PEM values into GitHub.

## Mobius Platform

Configure these **GitHub Environment variables** individually:

- `MOBIUS_PLATFORM_ALLOWED_ORIGINS` — JSON-encoded origin array.
- `MOBIUS_PLATFORM_OIDC_PROVIDERS` — JSON-encoded provider array.
- `MOBIUS_PLATFORM_OPERATOR_SUBJECTS` — JSON-encoded subject array.
- `SESSION_ACTIVE_SESSIONS_PER_PROJECT` — for example `1000`.
- `SESSION_ARCHIVE_BYTES_PER_SESSION` — for example `268435456`.
- `CLERK_PUBLISHABLE_KEY` — environment-specific frontend build key.
- `CLOUDFLARE_ACCOUNT_ID` — deployment account.

Set the **GitHub Environment secret** `CLOUDFLARE_API_TOKEN` for deployment.
Set the individual GitHub secret `CLERK_SECRET_KEY` when enabling organization
invite links. CD syncs it to the edge and regional Workers when supplied. See
`third-party/mobius/docs/platform-hosting.md` for authentication formats.

Platform previously used `mobius-relay-production` for both environments. Copy
deployment credentials into `staging` and `production` before enabling CD.
The standalone Relay deployment uses the original Environment.

## Migration and updates

Populate GitHub with current values before deploying these workflow changes.
Cloudflare cannot return secret plaintext; obtain it from the original store or
rotate the credential. Public settings formerly stored as Cloudflare secrets
belong in individual GitHub variables.

CD replaces ordinary Worker variables with GitHub's configured values. Wrangler
updates supplied secrets additively: omitting a secret does **not** delete it.
Explicitly delete retired secret bindings in Cloudflare after removing their
application dependency and GitHub configuration. Resource bindings, routes, and
migrations are defined in Wrangler configuration.

The Mobius workflow changes are published in a separate Mobius PR. Its CD runs
from Mobius main. Chat deploys its edge Worker and project Durable Object class
from this repository's Wrangler configuration.
