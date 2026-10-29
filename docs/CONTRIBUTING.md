---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Contributing to Morty

This guide is for developing Morty itself. To connect your Agent and use Morty,
start with the [README](../README.md) and [usage guide](GUIDE.md). Contributors should
use the [glossary](GLOSSARY.md) for Morty's application and Session terminology. See
[AGENTS.md](../AGENTS.md) for engineering rules and [TESTING.md](TESTING.md) for verification.

## Issues and pull requests

Read this guide before opening an issue or pull request.

Compatibility is mandatory unless the human user or maintainer explicitly requires
the particular breaking change. Follow the engineering rules and
[CODE_REVIEW.md](CODE_REVIEW.md). For a changed external contract, include the
affected peers, both mixed-version verification results, and rollout/recovery
consequences in the PR; cite the explicit instruction for any intentional break.

- Write issue titles and descriptions in English.
- Write pull request titles and descriptions in English.
- Write code comments in English.
- Format pull request titles as Conventional Commits:
  `<type>(<optional-scope>): <imperative summary>`. Omit the parentheses when
  no scope is needed, for example `chore: update dependencies`.
- Describe the problem, expected behavior, and relevant reproduction steps in
  issues. For feature requests, describe the user need and desired outcome.
- In pull requests, explain the change, link related issues, and include relevant
  verification results and any limitations.
- Keep Markdown changes in documentation-only pull requests, separate from code,
  configuration, dependencies, and submodule updates.

## Local development

Use the Node and pnpm versions pinned in [package.json](../package.json), then install
the workspace and sync the Mobius submodule:

```sh
pnpm install
pnpm sync:submodules
pnpm local-dev --help
```

Use [the local-stack skill](../.agents/skills/chat-local-full-dev/SKILL.md) for isolated
Chat and Platform startup and cleanup. Protocol and SDK workspace dependencies come
from the Mobius submodule; sync it before repository work.
Runtime configuration is described in [deployment](deployment.md).

## Build and artifact operations

### Web asset CDN

Staging and production builds load content-addressed JavaScript and CSS from an
append-only R2 bucket. Deployments upload the new assets before activating the
new Worker, so an already-open page can continue loading its original chunks
after later deployments. Do not delete objects from these buckets.

Provision the buckets and their custom domains once, replacing each zone ID
with the Cloudflare zone that owns the domain:

```sh
pnpm exec wrangler r2 bucket create morty-staging-web-assets
pnpm exec wrangler r2 bucket domain add morty-staging-web-assets --domain assets.morty.paradev.biz --zone-id <PARADEV_ZONE_ID> --min-tls 1.2 --force
pnpm exec wrangler r2 bucket cors set morty-staging-web-assets --file config/r2/staging-web-assets-cors.json --force

pnpm exec wrangler r2 bucket create morty-production-web-assets
pnpm exec wrangler r2 bucket domain add morty-production-web-assets --domain assets.morty.build --zone-id <MORTY_BUILD_ZONE_ID> --min-tls 1.2 --force
pnpm exec wrangler r2 bucket cors set morty-production-web-assets --file config/r2/production-web-assets-cors.json --force
```

The deployment token needs R2 object-write permission for both web asset
buckets. Objects are served with a one-year immutable browser cache policy;
their content hashes make overwriting unnecessary.

### Setup download

Users must be able to download and run the setup artifact without installing its
library dependencies separately. The download must serve a deployment-owned artifact;
request parameters must not select arbitrary storage objects. Missing artifacts must
produce a clear, retryable failure rather than an incomplete setup script.

Keep setup intent (identity and Bot configuration) separate from daemon-owned pairing
and connection state.

The CD token needs R2 object write permission on the existing attachments bucket. CD
uploads the generated bundle before deploying Workers. To seed or refresh local
development R2:

```sh
pnpm build:setup
pnpm exec wrangler r2 object put morty-local-apac-attachments/artifacts/setup.mjs --file packages/setup/dist/setup.mjs --local
```
