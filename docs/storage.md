# Cloud storage

Morty stores each workspace in a Project Durable Object and uses R2 for the setup
artifact.

- Project Durable Object SQLite stores management and chat records using
  `packages/worker/migrations/project-do`.
- The APAC attachment bucket stores the setup artifact.

Database and R2 binding values are validated at the Worker boundary; missing
bindings fail closed.
