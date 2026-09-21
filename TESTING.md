# Testing Guide

## Purpose

Tests are the executable control surface for Mobius Chat. Each supported behavior
has one primary owner:

- a browser E2E journey owns a critical successful user path;
- a Worker integration test owns one HTTP, Durable Object, Slack, or storage
  boundary;
- Mobius owns its protocol, Runtime, daemon, Relay, and Agent boundaries.

Prefer a few long journeys over many E2E cases. Repeat an assertion at another
level only for a distinct high-impact risk such as authorization, data integrity,
cancellation, cleanup, or external compatibility. Coverage does not justify a
duplicate scenario.

## Organization

### Browser product journeys

`packages/e2e/conversation.e2e.test.ts` covers an already-paired workspace.
`packages/e2e/setup.e2e.test.ts` covers setup handoff, native-session import,
remote work, media, reload, and revocation. These two Playwright scenarios are the
product E2E suite:

```bash
pnpm test:e2e
```

They start real local Chat, Platform, Mobius, Runtime, browser, HTTP, WebSocket,
filesystem, and database boundaries. A deterministic stateful ACP Agent replaces
only the third-party Agent. Extend an existing journey before adding another file.
See `packages/e2e/README.md` for scenario ownership.

### Worker integration

`packages/worker/tests` enters through the production Worker HTTP, WebSocket,
Durable Object, queue, or storage boundary. Run it with:

```bash
pnpm test:worker
```

The shared fixtures own application composition, migrations, credentials, external
fakes, and cleanup. Slack tests start empty and create app registration, binding,
OAuth, and connection state through production HTTP operations. Direct persistence
setup is reserved for storage and migration behavior or state owned by an upstream
component outside the test.

### Mobius

`third-party/mobius` has its own product E2E, protocol contracts, boundary
integration suites, and real Agent-daemon compatibility matrix. Its `TESTING.md`
is authoritative for those tests. Real Agent discovery, provider access, tool
execution, ACP translation, and daemon delivery belong there. Chat's browser E2E
uses one deterministic ACP Agent and owns only the integration that can break in
Chat: setup, messages, controls, media rendering, local-file pulling, persistence,
and revocation.

## Scenario rules

Write titles as executable specifications:

```text
Given [observable context], When [an actor performs an action], Then [an observable result occurs]
```

Use the same supported entrypoint and production composition as the level being
tested. Assert observable results: HTTP responses, events, persisted state,
filesystem effects, accessible DOM, process status, and typed errors. Do not assert
private calls, incidental ordering, or internal implementation details.

Prepare state through the cheapest production business operation available at the
tested boundary. Harnesses may hide startup, ports, credentials, waiting,
diagnostics, and cleanup; they must not hide the business action or bypass a
participating production layer.

Unit tests are prohibited by default. Naming a direct helper or class test
`integration` does not make it one. Move the assertion to its owning boundary or
delete it when a stronger journey already owns the behavior.

Mocks, spies, module replacement, monkey patching, and canned request interceptors
are prohibited. A dependency outside the product may use one stateful fake through
its production port when the real service cannot run safely or deterministically.

Time-sensitive tests use a fixed fake clock and explicit advancement. Do not use
real sleeps, polling loops, or timing tolerances. Async tests wait for the event or
visible state that proves progress; a bounded scenario timeout is only failure
containment.

## CI and coverage

Pull requests and merge-queue revisions run two parallel jobs:

- `static`: typecheck, build, lint, architecture checks, migrations, and Knip;
- `tests`: the Worker boundary suite and its Istanbul report.

The required `check` job only combines those results. Main pushes do not repeat
them; they validate deployment configuration and deploy the merge-queue-verified
revision. Deterministic browser E2E is intentionally outside PR CI. Real Agent
compatibility runs in Mobius instead of being repeated here.

`pnpm test:coverage` covers production Worker TypeScript and writes LCOV, JSON,
and HTML output. The 95% target is advisory; failed tests and missing or empty
reports are blocking. Code executed in a separately bundled Worker or subprocess
is not credited to the parent runner, so percentages cannot prove a product path.

Run `pnpm typecheck`, `pnpm lint`, and only the affected suites locally. Reserve
`pnpm ci:check` for CI.

## Authentication and visual checks

Worker authentication scenarios use the shared fake Clerk, which issues real
RSA-signed tokens at a fixed clock. Hosted Clerk sign-in and sign-up remain manual
because the external hosted UI is outside the product boundary.

Browser-specific layout and appearance remain manual unless they become a critical
supported behavior. Functional browser journeys use accessible roles, labels, and
visible results rather than screenshots or private application state.

Architecture rules are executable in `dependency-cruiser.config.cjs`. Shared Slack
records live with their owning entity boundary; storage and infrastructure cannot
depend on services, HTTP, composition, or gateways; browser and Worker
implementations cannot import each other.
