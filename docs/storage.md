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
prompt recovery records. Its implementation is currently on `feat/slack-migration`.

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

Each business deploys independently and applies its own migrations across the
environment's shards before releasing code that requires them. Serialize releases
of the same business and environment in its CI. Different businesses must not
change one another's tables, indexes, triggers, or migration histories, and must
avoid cross-business foreign keys and SQL joins. D1 serializes database work;
large schema changes still affect every business sharing that shard. Coordinate
such changes through a scheduled release rather than introducing a new lock
service by default. GitHub concurrency groups do not coordinate separate repos.

Use additive, backward-compatible migrations for rolling deployments. Keep old
code working while shards are upgraded; do not publish code that requires a
migration that failed on one of its target shards. Backfills should be bounded
and resumable. A new shard must receive every enabled business's migrations at
the deployed versions before it can accept workspaces.

Both current service configurations use the default `d1_migrations` history.
Their current table names also do not fully follow the namespaces above. Moving
existing data requires an explicit schema/data migration and migration-history
baseline. Changing the history table name alone would cause old migrations to
appear unapplied. No existing databases, histories, or service bindings were
modified as part of this provisioning work.

Table ownership is an application convention, not a D1 permission boundary. A
Worker with a D1 binding can access the whole database. Choose separate databases
if businesses later require database-enforced separation, independent whole-DB
restore, or independent capacity. Wrangler migrations support both layouts.

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
