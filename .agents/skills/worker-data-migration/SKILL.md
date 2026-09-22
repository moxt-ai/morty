---
name: worker-data-migration
description: Migrate persisted Worker data (Durable Object SQLite and control-plane D1) across a deployed Mobius Platform staging or production environment. Use when a merged migration needs an explicit operator run against existing Project and Session Durable Objects, or when a one-off data backfill must execute on the edge.
---

# Worker Data Migration

Run an explicit data migration against already-deployed Cloudflare Workers when
the schema change ships with the code but existing Durable Object storage still
needs upgrading. This covers the Mobius Platform cloud-retention migration
(`POST /v1/platform/migrations/cloud-retention`), which enumerates every Platform
Project, migrates its Project and Session Durable Objects, and records per-Project
completion.

Schema migrations for the control-plane D1 apply automatically in CD before the
Worker deploys. This skill is for the data pass that the schema does not perform.

## When this applies

- A merged change adds a migration that must touch existing Durable Object
  storage, not just control-plane D1.
- The migration endpoint is operator-gated and no operator subject is configured
  in the target environment, so the HTTP route is unreachable.
- The user explicitly asks to run the migration on staging or production.

Do not use this skill to apply schema migrations, to deploy application code, or
against an environment the user did not name.

## Core approach

Do not weaken the operator gate or change production configuration to run the
migration. Instead, deploy a short-lived, token-gated helper Worker into the same
account. It binds the deployed Durable Object class by `script_name` and the
control-plane D1, so it reaches the real Durable Objects through Cloudflare's
internal network. Tear it down when the run finishes.

`scripts/migrator-worker.ts` is that helper. `scripts/migrate.sh` deploys it,
drives the migration in batches, verifies completion, and deletes it on exit.

## Procedure

1. Resolve the Mobius checkout. In the Chat repository it is `third-party/mobius`.
   Confirm `git status --short` is clean there; if a rebase or merge is in
   progress, stop and report rather than resolving it.
2. Read the target environment's names from
   `packages/relay-cloudflare-platform/wrangler.jsonc`: the Worker `name`, the
   `PLATFORM_DIRECTORY_DATABASE` `database_name` and `database_id`. Never guess a
   database for an environment.
3. Confirm the deployed Worker already includes the migration endpoint. Health is
   `GET /mobius/api/dashboard/health`; the migration route is operator-gated and
   returns `401` without a developer credential, which is expected.
4. Run the migration:

   ```sh
   scripts/migrate.sh staging
   scripts/migrate.sh production
   ```

   Migrate staging first, confirm it completes, then production.
5. Verify independently of the helper with D1 before reporting:

   ```sql
   SELECT (SELECT COUNT(*) FROM platform_projects) AS total,
          (SELECT COUNT(*) FROM platform_cloud_retention_migrations) AS migrated;
   ```

   `total` must equal `migrated`, or `total - migrated` is the remaining count.

## Constraints

- Treat the helper as privileged and temporary. Always delete it, including on
  failure; the script uses a trap for this.
- Keep the helper token in a mode `0600` file, pass it to the Worker as a secret,
  and never print it.
- Never point a helper at an environment the user did not name. State the target
  before starting.
- This runs real, idempotent side effects. Re-running is a no-op because
  completed Projects are skipped, but do not run it against an unrelated or
  unknown account.
- The corporate HTTP proxy intercepts Wrangler's remote-binding channel. Prefer
  deploying the helper to the edge over `wrangler dev --remote`; when a dev
  session is unavoidable, clear `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and
  their lowercase variants.

## Environment facts

- Cloudflare account ID is `95af7a3d67be8c49b1619544e3ce53c0`.
- Staging Worker `mobius-platform-staging`; production `mobius-platform-production`.
- D1 bindings and IDs live in `packages/relay-cloudflare-platform/wrangler.jsonc`.
- Operator subjects (`MOBIUS_PLATFORM_OPERATOR_SUBJECTS`) are empty in both
  environments, so the operator HTTP route cannot be used directly.

## Scripts

`scripts/migrate.sh <staging|production>` — deploys the helper, drains the
migration in batches of 10, verifies `total == migrated`, and deletes the helper.
Set `MOBIUS_REPOSITORY` to override the Mobius checkout path, and
`CLOUDFLARE_ACCOUNT_ID` to override the account.

## Repair an already-corrupted non-cloud-retention Turn

Use this separate procedure only for a confirmed incident where the persisted
Turn command is no longer decodable (for example, the old scrubber replaced the
prompt with an empty string and also removed attachments). The normal migration
does not repair Turn content, and this procedure must not be used as a general
scrub operation.

The repair build adds a token-gated `repair-scrubbed-turn` operation to the
non-cloud-retention Session Durable Object. Build and deploy that temporary
Platform Worker revision first; do not leave the repair route in the normal
application deployment. Then run:

```sh
scripts/repair-turn.sh production \
  <projectId> <runtimeId> <sessionId> <commandId> <turnId>
```

Use `staging` only when the incident is in staging. Resolve every identifier
from the authoritative session/project directory and verify that the resolved
Project, Runtime, Session, Command, and Turn are the intended target before
running the command. The script:

1. deploys a short-lived helper bound to the named Platform Worker;
2. creates random helper and repair tokens in mode `0600` files;
3. installs the repair token as `NON_CLOUD_RETENTION_TURN_REPAIR_TOKEN`;
4. confirms the Turn is unreadable before repair, applies the one-shot repair,
   and confirms the production read path returns a readable Turn with
   `content: "[Content unavailable]"`;
5. deletes the helper and removes the repair secret on success or failure.

The repair preserves the stored command's protocol identity and configuration,
removes images/resources, and clears response/error text. It must never fabricate
identity fields or rewrite a healthy Turn. For a session with multiple affected
Turns, use the same temporary repair build's all-Turn operation through a
reviewed operator command; apply it only after independently authorizing the
single Project/Runtime/Session target and verify the session-level read path
afterward. Do not broaden this into an account-wide sweep without explicit
approval.
