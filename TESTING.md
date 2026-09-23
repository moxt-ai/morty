# Testing Guide

## Purpose

Tests are the executable control surface for Morty. Each supported behavior
has one primary owner:

- a browser E2E journey owns a critical successful user path;
- a Web application integration test owns browser-side behavior and state transitions;
- a Worker integration test owns one HTTP, Durable Object, Slack, or storage
  boundary;
- Mobius owns its protocol, Runtime, daemon, Relay, and Agent boundaries.

Prefer a few long journeys over many E2E cases. Repeat an assertion at another
level only for a distinct high-impact risk such as authorization, data integrity,
cancellation, cleanup, or external compatibility. Coverage does not justify a
duplicate scenario.

## Organization

### Browser product journeys

`packages/e2e/conversation.e2e.test.ts` covers one paired conversation from an
image prompt through an Agent tool response and persisted reload.
`packages/e2e/setup.e2e.test.ts` covers setup handoff, native-session import,
reload, and revocation. These two
files contain the product E2E journeys:

```bash
pnpm test:e2e
```

They start real local Chat, Platform, Mobius, Runtime, browser, HTTP, WebSocket,
filesystem, and database boundaries. A deterministic stateful ACP Agent replaces
only the third-party Agent. Extend an existing journey before adding another file.
See `packages/e2e/README.md` for scenario ownership.

### Web application integration

`packages/web/tests` renders the authenticated workspace application in a lightweight
DOM and drives it through visible user-facing elements. Run it with:

```bash
pnpm test:web
```

The production router, API clients, view-models, Zustand stores, React views, Chat
Worker, Project Durable Objects, Platform Worker, Platform Durable Objects, and
WebSocket transports all participate. They run in local in-memory Cloudflare
runtimes. A single stateful fake Agent-daemon replaces the external local process and
answers the real Runtime protocol with a representative Agent and model directory,
sessions, messages, events, and file reads. Do not inject stores, render an isolated
component, or replace Chat or Platform with response tables.

This is the default owner for browser-side branching that needs the real Chat and
Platform path, including loading, reconnecting, queued work, history reconciliation,
errors, and rendering. A few business-owned cases share one production local stack
and create an isolated Project for each scenario; do not rebuild Chat and Platform
for every branch. Browser E2E retains only the proof that deployed-style
processes and a real browser connect. A Web bug should not require another full-stack
E2E step when it can be reproduced through this in-memory stack. Bot management,
Agent configuration filtering, media rendering, local-file pulling, and Runtime
scoping therefore live in this journey; the browser suite does not repeat them.

### Worker integration

`packages/worker/tests` enters through a production HTTP, WebSocket, Durable
Object, Slack application, queue, or storage boundary. Run it with:

```bash
pnpm test:worker
```

The shared fixtures own application composition, migrations, credentials, external
fakes, and cleanup. A suite shares its production local runtime when each case can
create isolated users and Projects through public operations; do not rebuild the
same Worker bundle and Platform for every case. `startTestPlatform` starts the production Platform Worker,
Durable Objects, migrations, and HTTP/WebSocket boundary with isolated local
Cloudflare storage; it does not simulate Platform responses. Slack tests start empty and create app registration, binding,
OAuth, and connection state through production HTTP operations. Direct persistence
setup is reserved for storage and migration behavior or state owned by an upstream
component outside the test.

Keep one file per business boundary. Identity lifecycle and pairing-ticket HTTP
behavior belong in `identity.integration.test.ts`; the setup CLI and browser
handoff belong to the existing product journey in `packages/e2e/setup.e2e.test.ts`.
Slack journeys stay under `slack/app`. Related state transitions should advance
through one journey instead of rebuilding the same user, database, and Platform
stack in separate cases. The small shared `support/identity-fixture.ts` starts real
Chat Durable Objects and composes them with the real local Platform. Chat creation
uses production Chat and Platform business operations end to end; only the external
Agent-daemon process is replaced by the shared protocol fake. Narrow peers are
reserved for a boundary behavior that a healthy Platform cannot produce, such as
rejecting an HTTP redirect.
Slack journeys compose the production Slack application and queue consumer with
stateful fakes at the external Clerk, Slack, Identity, and Platform ports.

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

Isolated helper, class, store, and component tests are prohibited by default. Naming
one `integration` does not make it one. Prefer the cheapest production boundary that
still executes the behavior's real composition: the complete Web application, the
Worker entrypoint, or a long browser journey. Delete a lower-level assertion when a
stable boundary test already owns the same risk.

Mocks, spies, module replacement, monkey patching, and canned request interceptors
are prohibited. A dependency outside the product may use one stateful fake through
its production port when the real service cannot run safely or deterministically.

Do not make a real Cloudflare isolate pretend to share the test runner's fake
clock. Assert generated deadlines structurally at this boundary; test elapsed-time
rules at the owning storage or protocol boundary. Do not use real sleeps, polling
loops, or timing tolerances. Async tests wait for the event or visible state that
proves progress; a bounded scenario timeout is only failure containment.

## CI and coverage

The normal deterministic command runs the lightweight application and Worker
boundaries only:

```bash
pnpm test
```

Run the heavier browser journeys explicitly with `pnpm test:e2e`.

Pull requests and merge-queue revisions validate Worker configuration and run two
parallel verification jobs:

- `static`: typecheck, build, lint, architecture checks, migrations, and Knip;
- `tests`: the Web application and Worker boundary suites and their Istanbul report.

The required `check` job only combines those results. Main pushes do not repeat
them; they validate deployment configuration and deploy the merge-queue-verified
revision. Deterministic browser E2E is intentionally outside PR CI. Real Agent
compatibility runs in Mobius instead of being repeated here.

`pnpm test:coverage` covers production Web and Worker TypeScript and writes LCOV,
JSON, and HTML output. The 95% target is advisory; failed tests and missing or empty
reports are blocking. Code executed in a separately bundled Worker or subprocess is
not credited to the parent runner, so percentages cannot prove a product path.

Run `pnpm typecheck`, `pnpm lint`, and only the affected suites locally.
`pnpm ci:check` is the serial reproduction of CI's static and coverage jobs; keep
it for diagnosing the combined check rather than routine local iteration.

## Authentication and visual checks

Worker authentication scenarios use the shared fake Clerk, which issues real
RSA-signed tokens through Clerk's production authentication port. Hosted Clerk
sign-in and sign-up remain manual because the external hosted UI is outside the
product boundary.

Browser-specific layout and appearance remain manual unless they become a critical
supported behavior. Web and browser tests prefer accessible roles and labels. Use a
shared test ID when an element has no stable semantic selector or the ID expresses a
supported product state; do not use private application state or ad hoc selectors.

Architecture rules are executable in `dependency-cruiser.config.cjs`. Shared Slack
records live with their owning entity boundary; storage and infrastructure cannot
depend on services, HTTP, composition, or gateways; browser and Worker
implementations cannot import each other.
