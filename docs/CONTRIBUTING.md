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
the locked Morty workspace:

```sh
pnpm install --frozen-lockfile
pnpm local-dev --help
```

Use [the local-stack skill](../.agents/skills/chat-local-full-dev/SKILL.md) for isolated
Chat and Platform startup and cleanup. Runtime, protocol, client, and server
sources belong to the same Morty workspace. Normal Morty builds must not require
the original Mobius distribution; use an isolated released copy only when
verifying coexistence with Moxt.
Runtime configuration is described in [deployment](deployment.md).

## Build and artifact operations

### Web asset CDN

Production and benchmark builds load content-addressed JavaScript and CSS from
separate append-only R2 buckets. Deployments upload new assets before activating
Workers so an open page can still load its original chunks. Never delete these
objects during ordinary deployment. Provision resources using the independent
Morty targets and give each environment only its own deployment authority.

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
