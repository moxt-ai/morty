# GitHub-managed Worker configuration

After this, an operator can update individual runtime variables and secrets in
GitHub and see them applied to Cloudflare by the next successful CD deployment.

Both `moxt-ai/morty` and `moxt-ai/mobius` use separate `staging` and
`production` GitHub Environments. Each runtime setting has its own GitHub name;
the workflows explicitly map those names to Worker bindings. Configuration is
validated by `scripts/validate-worker-config.ts` before migrations/deployment.
The executable configuration and deployment steps are in
[Morty workflows](../.github/workflows/) and [Mobius workflows](../third-party/mobius/.github/workflows/).

## Chat

Configure these **GitHub Environment variables** individually:

- `APP_ORIGIN` — canonical Chat origin, without a trailing slash.
- `AUTHENTICATION_BASE_URL` — application authentication base URL.
- `CLERK_PUBLISHABLE_KEY` — environment-specific Clerk publishable key.
- `CLERK_JWT_KEY` — multiline PEM **public verification key**, not a private key.
- `MOBIUS_BASE_URL` — Platform origin.
- `MOBIUS_APP_ID` — environment-specific Platform App ID.

Configure these **GitHub Environment secrets** individually:

- `MOBIUS_APP_SECRET` — full `mapp_…` AppCredential.

Retain the deployment secrets `CLOUDFLARE_API_TOKEN`, `MOBIUS_READ_TOKEN`, and
`SENTRY_AUTH_TOKEN`, and the variables `SENTRY_DSN`, `SENTRY_ORG`, and
`SENTRY_PROJECT`. These are CD/build settings, not Worker bindings.

CD assembles a private temporary JSON file from the individual runtime secrets
and uploads it with the Worker version using Wrangler's `--secrets-file`. The
file is removed when the deployment step exits. Multiline values are encoded by
the script; enter actual multiline PEM values into GitHub.

The `production` GitHub Environment uses a one-minute deployment wait timer.

## Mobius Platform

Configure these **GitHub Environment variables** individually:

- `MOBIUS_PLATFORM_ALLOWED_ORIGINS` — JSON-encoded origin array.
- `MOBIUS_PLATFORM_OIDC_PROVIDERS` — JSON-encoded provider array.
- `MOBIUS_PLATFORM_OPERATOR_SUBJECTS` — JSON-encoded subject array.
- `SESSION_ACTIVE_SESSIONS_PER_PROJECT` — for example `1000`.
- `CLERK_PUBLISHABLE_KEY` — environment-specific frontend build key.
- `CLOUDFLARE_ACCOUNT_ID` — deployment account.

See the [Mobius workflows](../third-party/mobius/.github/workflows/) for the
current deployment and migration token requirements. Resource bindings and database
names are defined in each Worker's Wrangler configuration.

## Updating settings

Staging Chat (`morty.paradev.biz`) calls production Platform (`mobius.moxt.ai`).
Use the matching App ID and full AppCredential (`mapp_...`), not its public key ID.

Cloudflare cannot return secret plaintext; obtain it from the original store or
rotate the credential. Never commit credentials. GitHub Environment settings are
validated by [validate-worker-config.ts](../scripts/validate-worker-config.ts).
Wrangler updates supplied secrets additively: omitting a secret does not delete it.
Remove retired secrets explicitly after removing their application dependencies.
