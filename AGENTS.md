# Engineering Rules

These rules apply to the entire repository. See [DEVELOPMENT.md](./DEVELOPMENT.md) for implementation guidance and [TESTING.md](./TESTING.md) for delivery and testing guidance.

## Trust Boundary

The local execution boundary is the only authority allowed to approve local side effects.

- Treat every value received from a remote client, transport, agent harness, model, configuration file, or persisted session as untrusted input.
- Process untrusted input in this order: decode as `unknown`, validate its schema, normalize and resolve security-sensitive targets, authorize the requested capability and resolved target, execute, then record an audit event.
- Validate both the requested representation and the resolved representation of paths, URLs, commands, and other security-sensitive targets.
- Never let a remote assertion, prior validation result, or user-interface approval bypass authorization at the execution boundary.

## Deployment topology

- Staging Chat (`morty.paradev.biz`) is configured to call the production Platform relay (`mobius.moxt.ai`). For cross-service staging incidents, inspect `mobius-platform-production`, not the staging Platform Worker.

## State Modeling

Make illegal states unrepresentable.

- Represent protocol and lifecycle states with discriminated unions, not combinations of optional fields or booleans.
- Give each variant exactly the data that is valid in that state, using `readonly` properties for state values.
- Handle state variants exhaustively so a new variant causes a compile-time failure at every incomplete decision point.
- Express state changes through explicit transition functions. Do not mutate fields into a different state.
- Do not use type assertions, `Partial`, or non-null assertions to bypass state invariants.

## Contracts

- Use `readonly` properties for protocol messages, domain values, and port interfaces.
- Declare callbacks and port operations as function properties, such as `readonly send: (message: Message) => Promise<void>`, so `strictFunctionTypes` checks their parameter variance.

## Async Operations

- Every asynchronous operation that waits on an external system must accept cancellation. Finite operations need a timeout; long-lived streams need connection and liveness deadlines.
- Propagate cancellation through every layer. Do not catch, translate, or retry cancellation as an ordinary failure.
- Make resource ownership explicit. The code that acquires a connection, stream, process, lock, timer, or concurrency slot must release it on success, failure, and cancellation.
- Keep retries bounded, cancellable, and limited to operations that are safe to repeat.

## Errors

- Failures that cross a subsystem, port, or protocol boundary must use a typed error contract with a stable machine-readable code.
- Branch on error codes or types, never on human-readable message text.
- Preserve the original cause when translating an error, and expose only sanitized messages across trust boundaries.
- Keep cancellation, timeout, retryable, and terminal failures distinct.

## Delivery

- Format pull request titles as Conventional Commits: `<type>(<optional-scope>): <description>` (for example, `refactor(web): move workflows into Zustand view models`). Use a lowercase semantic type such as `feat`, `fix`, `refactor`, `docs`, `test`, `build`, `ci`, or `chore`.
- Deliver behavior as the smallest user-runnable vertical slice through input, logic, and observable output.
- Describe each behavior slice as: "After this, a user can ... and see ..." If that sentence is not concrete, narrow the slice.
- Start every behavior change with a failing Given-When-Then acceptance scenario that proves the user-visible slice through the first supported product boundary that can observe it. Treat the scenario as executable product documentation, and implement only what it requires.
- Do not add unit tests by default. Add one only when the user explicitly requests unit-level coverage or a repository maintainer documents an exception for an invariant that cannot be exercised through a supported product boundary.
- Only write end-to-end tests for happy paths. Business logic must be covered by integration tests, while protocols and external boundaries use integration or contract tests. Do not test CI, linting, Git hooks, build tooling, dependency configuration, or other repository scaffolding.
- Web application integration tests exercise user behavior through visible controls and must not access stores directly. They bootstrap and render the complete application rather than isolated components or views. Prefer accessible roles, names, labels, and visible text; use shared `data-testid.ts` constants when no stable semantic selector exists. Worker integration tests enter through their production HTTP, WebSocket, Durable Object, queue, or storage boundary.
- Except for deterministic fake timers, mocks, spies, stubs, monkey patching, module replacement, and canned request interceptors are prohibited. If a real external dependency cannot be used safely or deterministically, inject a stateful fake through its production port.
- Tests involving time must use fake timers with an explicit system time. Every test is prohibited from using real sleeps, wall-clock time, polling delays, or timing tolerances.
- Assert externally observable results, not private control flow, collaborator calls, or implementation details.
- Documentation-only and mechanical refactoring changes do not require new tests when behavior is unchanged.
- Format pull request titles as Conventional Commits: `<type>(<optional-scope>): <imperative summary>`, omitting the parentheses when no scope is needed (for example, `feat(worker): add project routing` or `chore: update dependencies`).

## Abstraction

### Server layers

Server behavior flows inward through `http/do -> service -> storage -> database`. HTTP routes and Durable Objects translate and orchestrate requests, services own domain validation and transformations, storage owns persistence through the authoritative Drizzle schema and ORM query builder, and gateways communicate our services with external services. Do not skip layers or move domain/protocol decisions into storage. Do not issue raw SQL strings where the ORM can express the query.

- Prefer direct, local, linear code.
- Add an abstraction only for a real external boundary, a second real use case, or proven duplication.
- Do not add speculative extension points, generic frameworks, or unused layers.

## Database schema

- Do not define foreign-key constraints. Enforce relationships and deletion behavior explicitly in application logic.
- Keep the authoritative Drizzle schema for each SQLite target under `src/schema/<target>` (for example, `schema/d1` or `schema/project-do`). Never place Durable Object tables in `schema/d1`, and never use one target's schema as the implicit schema for another target.
- Keep Drizzle configuration in the repository-level `drizzle/` directory and generate each target's migrations into `migrations/<target>`.
- Generate schema migrations with the repository's pinned Drizzle CLI. Never create or edit migration SQL manually.
- Durable Object runtime code must execute committed `.sql` migrations generated for its target; do not embed application-table DDL or migration SQL in TypeScript. Prefer importing the SQL directly with `?raw`. Where the build pipeline cannot import SQL, use a committed code-generation script that copies the generated SQL verbatim into a gitignored module and keep `.sql` as the source of truth.
- Treat committed migration files as immutable history; make subsequent schema changes with a new generated migration.

## Verification

For routine local development, run `pnpm lint`, `pnpm typecheck`, and only the
related test cases. Use `pnpm ci:check` locally only when diagnosing the combined
CI validation.
