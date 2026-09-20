# Cloud storage

Mobius Cloud has one D1 database and one R2 attachment bucket per deployment
environment.

- `DATABASE` stores all Slack integration records using
  `packages/worker/migrations/d1/0001_initial.sql`.
- `ATTACHMENTS` stores Slack files under user-prefixed object keys.

There is no shard inventory, region placement, Clerk Organization metadata, or
runtime storage router. D1 and R2 binding values are validated at the Worker boundary;
missing bindings fail closed.
