# Cloud storage

Morty stores each workspace in a Project Durable Object and uses regional R2
buckets for attachments.

- Project Durable Object SQLite stores management, chat, and Slack integration
  records using `packages/worker/migrations/project-do`.
- Regional attachment buckets store Slack files under user-prefixed object keys.

Database and R2 binding values are validated at the Worker boundary; missing
bindings fail closed.
