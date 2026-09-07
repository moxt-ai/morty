# Regional D1 shards

Cloud owns physical database provisioning and inventory. Its inventory is the
versioned [configuration file](../infra/d1-shards.json), not a database table.
Cloud itself has no D1 binding or business database. Each business owns its tables,
queries, and migration files in the shared shards.

## Current state

Six empty databases were created in Paraflow Cloud
(`95af7a3d67be8c49b1619544e3ce53c0`) on September 7, 2026:

| Environment | Region hint | Shards |
| --- | --- | --- |
| Production | `wnam` (western North America) | `wnam-01`, `wnam-02` |
| Production | `apac` (Asia-Pacific) | `apac-01`, `apac-02` |
| Staging | `wnam` | `wnam-01` |
| Staging | `apac` | `apac-01` |

The creation responses reported WNAM and APAC respectively. Database names and
UUIDs are recorded in the inventory. The databases have no business schema or
workspace assignments yet. Creating them does not activate application sharding.

The existing deployments still use their existing storage:

| Worker | D1 | Other storage |
| --- | --- | --- |
| `mobius-relay` | `mobius-relay-directory-database`, bound as `DIRECTORY_DATABASE` | Runtime and Session Durable Objects; `mobius-session-archives` R2 bucket |
| `mobius-slack-staging` | `mobius-slack-staging`, bound as `DATABASE` | R2 attachments, event queue, and an agent-trigger limiter Durable Object |
| Cloud staging and production | None | Clerk owns accounts and Organizations |

Mobius D1 stores pairing/channel access information, session indexes, and quota
reservations. Session Durable Objects store session state; archives use R2 in the
observed deployment. The current default source configuration is the Lite profile,
which stores archive chunks in Session Durable Object SQLite instead. Slack D1
stores installations, identity bindings, session mappings, event processing, and
prompt recovery records. Its implementation is maintained on the Slack repository's
`main` branch.

## Regional R2 buckets

Cloud owns the private R2 buckets in [infra/r2-buckets.json](../infra/r2-buckets.json).
There is one bucket per environment and region:

| Environment | Region hint | Bucket |
| --- | --- | --- |
| Staging | `apac` | `mobius-cloud-staging-apac-objects` |
| Staging | `wnam` | `mobius-cloud-staging-wnam-objects` |
| Production | `apac` | `mobius-cloud-production-apac-objects` |
| Production | `wnam` | `mobius-cloud-production-wnam-objects` |

Multiple D1 shards in one region can use the same R2 bucket. R2 does not impose
a fixed bucket storage or object-count limit, so adding a D1 shard does not
require another bucket. Location hints are best effort, not a specific city or
a mainland-China placement guarantee.

Use business and workspace prefixes when the new buckets are connected:
`mobius/<workspaceId>/archives/...` and `slack/<workspaceId>/attachments/...`.
Each business owns its object formats, versioning, and retention rules. Prefixes
are an ownership convention, not an authorization boundary. Keep buckets private
and authorize workspace access at the serving Worker before reading or writing.

R2 requires bucket provisioning and bindings, not SQL schema migrations. The four
buckets are initially empty; existing archive/attachment buckets and bindings
remain in use until regional runtime routing is implemented. Increasing D1 shard
count within a region must not force an object copy.

## Workspace placement

The intended mapping is:

```text
Clerk Organization privateMetadata
  -> logical shard ID within the configured environment
  -> database ID in infra/d1-shards.json
  -> the business's preconfigured D1 binding
```

For example, Cloud can maintain this small value on an Organization:

```json
{
  "mobiusCloud": {
    "placement": {
      "shardId": "apac-01",
      "revision": 1
    }
  }
}
```

Use the separate Clerk instance and shard inventory for each deployment
environment. Cloud is the application owner of this metadata. Backend access
is required for private metadata; no automatic allocator or metadata writes are
implemented yet. Before adding automatic allocation, define one serialized
assignment path so concurrent requests cannot assign a workspace twice.

Keep the inventory in configuration and stable assignment in Clerk. Capacity
metrics come from Cloudflare monitoring. Do not use Clerk metadata as a lock,
a frequently updated counter, or a transactional migration journal. Backend
metadata requests have latency and rate limits, so services should cache resolved
assignments with a bounded lifetime and invalidate them during planned moves.

Every service must validate the assignment against its configured environment,
resolve the database through the allowlisted inventory, and authorize the caller
for the workspace. An Organization ID, browser-supplied shard ID, or cached route
is not authorization. Rows and compound indexes must include the workspace scope.

Choose a workspace's home region based on its users and write workload. Keep it
stable when members travel; moving every request to a different writable database
would split the workspace's data. A workspace shared across continents still has
one primary write location. APAC is a regional hint, not a mainland-China location
or a promise of low cross-border latency.

## Independent schema migrations

Use Wrangler's standard SQL migration mechanism. Give each business a separate
migration directory in its own repository and a distinct `migrations_table` in
every shared database:

| Owner | Table, index, and trigger namespace | Migration history |
| --- | --- | --- |
| Mobius | `mobius_*` | `mobius_migrations` |
| Slack | `slack_*` | `slack_migrations` |

The namespace column is the target ownership convention; current initial schemas
still contain some unprefixed tables. The migration commands below do not rename
those tables.

An illustrative Mobius binding is:

```jsonc
{
  "binding": "DIRECTORY_DATABASE",
  "database_name": "mobius-cloud-production-apac-01",
  "database_id": "9ba3f0bb-59f4-4a43-bf51-2a2317e75d01",
  "migrations_dir": "migrations/d1",
  "migrations_table": "mobius_migrations"
}
```

Slack binds the same physical database with its own binding name, migration
folder, and `migrations_table: "slack_migrations"`. Both repositories may contain
`0001_initial.sql`; their applied histories remain independent. A local Wrangler
verification applied files with this identical name through two configurations
to one database and confirmed both business tables and both history records.

Cloud CD applies each business's migrations across the selected environment's
new shared shards before deploying the Cloud Worker. Cloud releases are serialized
per environment. Existing standalone service deployments and their databases
remain managed by their original repositories. Different businesses must not
change one another's tables, indexes, triggers, or migration histories in a shared
shard, and must avoid cross-business foreign keys and SQL joins. D1 serializes
database work; large schema changes still affect every business sharing that shard.
Coordinate these shared-shard changes through Cloud's release.

Use additive, backward-compatible migrations for rolling deployments. Keep old
code working while shards are upgraded; do not publish code that requires a
migration that failed on one of its target shards. Backfills should be bounded
and resumable. A new shard must receive every enabled business's migrations at
the deployed versions before it can accept workspaces.

Each business now exposes `pnpm db:shard` to initialize a selected database from
this inventory. Run these commands from a checkout with submodules initialized:

```bash
git submodule update --init --recursive
inventory="$(pwd)/infra/d1-shards.json"
pnpm --dir mobius db:shard "$inventory" staging apac-01 --local
pnpm --dir apps/slack db:shard "$inventory" staging apac-01 --local
```

Use `--remote` explicitly when applying a release to a Cloud database, and repeat
for each target shard in the chosen environment. Install each service's own
pnpm dependencies first. The commands require Bash, jq, realpath, and timeout.
They validate the selected target, print its name and UUID, and run native
Wrangler migrations with `mobius_migrations` or `slack_migrations` respectively.
See the [Mobius migration guide](../mobius/docs/d1-migrations.md) and
[Slack migration guide](../apps/slack/docs/d1-migrations.md) for release commands.

New shards start from each business's initial SQL migration. There is no legacy
history adoption, baseline copying, or existing-database conversion. The current
Worker database and object-storage bindings remain unchanged.
Initializing schema does not assign a workspace or switch runtime traffic, and
no remote schema application is part of this repository synchronization.

Table ownership is an application convention, not a D1 permission boundary. A
Worker with a D1 binding can access the whole database. Choose separate databases
if businesses later require database-enforced separation, independent whole-DB
restore, or independent capacity. Wrangler migrations support both layouts.

## Release inventory and migration gate

Cloud's `CI` workflow owns releases of the Cloud Worker and migrations on the new
Cloud-managed shared shards. It selects a Cloud commit, including the D1/R2
inventories and pinned Mobius and Slack migration revisions. Both business
repositories expose a source-only internal action; GitHub downloads it with a
temporary scoped token. `.github/actions/business-sources` checks the action SHAs
against Cloud's submodules and installs the migration dependencies. Update both
pins together when selecting a new business version.

Pull requests apply both businesses' migrations locally to all staging and
production shards using the same local database state for both businesses.
Cloud CD builds its own Worker first, then applies both
businesses' SQL to every shard in the selected environment with `--remote`, then
deploys Cloud. A migration failure stops deployment. The complete sequence is
serialized per environment with cancellation disabled for a running release;
migrations already applied remain recorded if a later shard fails. Use
backward-compatible SQL so an incomplete migration rollout can be resumed.

Main pushes release Cloud staging; manual dispatch on main selects staging or
production. Existing standalone deployments, including `mobius-relay.paraflow.biz`
and Slack staging, retain their original workflows, domains, and storage. Cloud
CD neither deploys those Workers nor migrates their databases. Updating the
shared-shard migration source pin does not change a standalone deployment target.

Cloud's Worker still has no D1 binding or SQL schema. Its CD invokes the migration
commands owned by each business. R2 has no SQL migration step: Cloud provisions
its buckets, and businesses bind them when runtime routing is ready. There is
no copying or adoption of old database histories.

## Capacity and relocation

Monitor database size, query latency, overload errors, and write load per shard.
On Workers Paid, D1 has a 10 GB maximum per database; Workers Free has a 500 MB
maximum. Add shards before reaching the applicable storage or throughput limit,
and assign new workspaces only to shards with headroom. A static workspace count
is not a reliable capacity limit. Adding databases does not raise account quotas.

Read replication can reduce distant read latency and distribute read load. It
requires application use of the Sessions API, including bookmarks where needed
for consistency. Writes still go to the primary; replicas do not increase its
write capacity or the database's size limit. Shards distribute independent writes.

Retain the existing separation between D1 indexes, Durable Object session state,
and object/archive storage. Shared D1 shards do not mean putting all chat archive
bytes and attachments into D1.

A future workspace move must fence writes on the old shard, copy and verify the
workspace's data for every business, switch the Clerk assignment and revision,
invalidate caches, and then enable writes on the new shard. Updating metadata
alone does not move data. Until that workflow exists, assignment changes should
remain controlled operations. A very large workspace may eventually need a
purpose-built partitioning scheme beyond workspace-level placement.

D1 charges for usage and stored data rather than a fixed fee per database. Shared
shards primarily reduce migration and inventory fan-out; a dedicated database is
still an option for an unusually large or isolated workspace.

## References

- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/)
- [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Clerk Organization metadata](https://clerk.com/docs/guides/organizations/metadata)

- [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)
- [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
- [Sharing internal GitHub Actions](https://docs.github.com/en/actions/how-tos/reuse-automations/share-with-your-organization)
