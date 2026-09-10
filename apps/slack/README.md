# Slack backend

This directory is tracked directly by Mobius Cloud.

- `packages/api`: Slack application logic and integration scenarios.
- `packages/worker`: Cloudflare storage, queue, rate-limiter adapters, and SQL migrations.
- `scripts`: Per-environment database migrations used by Cloud deployment.

The frontend lives in `../../packages/web/src/slack`. The deployed Worker entry
point is `../../packages/worker/src/index.ts`.

Use the repository root's `pnpm install`, `pnpm dev`, and `pnpm check`. Cloud CI
builds the shared frontend/Worker and runs the Slack API scenarios. There is no
separate Slack frontend build or submodule checkout.
