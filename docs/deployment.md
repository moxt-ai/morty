---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

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
- `MOBIUS_BASE_URL` — Platform origin.
- `MOBIUS_APP_ID` — environment-specific Platform App ID.

Configure these **GitHub Environment secrets** individually:

- `MOBIUS_APP_SECRET` — full `mapp_…` AppCredential.

Retain the deployment secrets `CLOUDFLARE_API_TOKEN`, `MOBIUS_READ_TOKEN`, and
`SENTRY_AUTH_TOKEN`, and the variables `SENTRY_DSN`, `SENTRY_ORG`, and
`SENTRY_PROJECT`. These are CD/build settings, not Worker bindings.

CD assembles a private temporary JSON file from the individual runtime secrets
and uploads it with the Worker version using Wrangler's `--secrets-file`. The
file is removed when the deployment step exits.

The `production` GitHub Environment uses a one-minute deployment wait timer.

## Mobius Platform

Configure Platform independently using the
[Mobius workflows](../third-party/mobius/.github/workflows/) for its current
runtime, frontend, deployment, and migration requirements. Chat's anonymous
identity flow does not configure Platform developer authentication.
Resource bindings and database
names are defined in each Worker's Wrangler configuration.

## Updating settings

Staging Chat (`morty.paradev.biz`) calls production Platform (`mobius.moxt.ai`).
Use the matching App ID and full AppCredential (`mapp_...`), not its public key ID.

Cloudflare cannot return secret plaintext; obtain it from the original store or
rotate the credential. Never commit credentials. GitHub Environment settings are
validated by [validate-worker-config.ts](../scripts/validate-worker-config.ts).
Wrangler updates supplied secrets additively: omitting a secret does not delete it.
Remove retired secrets explicitly after removing their application dependencies.
