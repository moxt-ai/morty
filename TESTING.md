# Testing Guide

## Purpose

Tests are the executable control surface for Morty. Each supported behavior
has one primary owner:

- a browser E2E journey owns a critical successful user path;
- a Web application integration test owns browser-side behavior and state transitions;
- a Worker integration test owns one HTTP, Durable Object, or storage
  boundary;
- Mobius owns its protocol, Runtime, daemon, Relay, and Agent boundaries.

Prefer a few long journeys over many E2E cases. Repeat an assertion at another
level only for a distinct high-impact risk such as authorization, data integrity,
cancellation, cleanup, or external compatibility. Coverage does not justify a
duplicate scenario.

## Organization

### Browser product journeys

`packages/e2e/conversation.e2e.test.ts` covers send, reply, and browser reload.
`packages/e2e/setup.e2e.test.ts` covers Project pairing and saved Runtime reconnect
with a QR handoff. Both use the shared stateful fake daemon; Setup additionally
injects its local CLI port while running the real downloaded setup bundle.
Run the product journeys with:

```bash
pnpm test:e2e
```

The product-test target is real Chat, Platform, SDK, Runtime relay, HTTP,
WebSocket, storage, and browser boundaries, with one stateful **fake daemon** at
the daemon protocol port. The fake owns controllable session state, queued work,
streaming, interactions, and files. It must not replace the SDK, Platform, or Chat.
Agent-specific adaptation belongs to separate real agent-daemon tests, not browser
journeys. Extend an existing journey before adding another file.

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
Object, or storage boundary. Run it with:

```bash
pnpm test:worker
```

The shared fixtures own application composition, migrations, credentials, external
fakes, and cleanup. A suite shares its production local runtime when each case can
create isolated users and Projects through public operations; do not rebuild the
same Worker bundle and Platform for every case. `startTestPlatform` starts the production Platform Worker,
Durable Objects, migrations, and HTTP/WebSocket boundary with isolated local
Cloudflare storage; it does not simulate Platform responses. Direct persistence
setup is reserved for storage and migration behavior or state owned by an upstream
component outside the test.

Keep one file per business boundary. Identity lifecycle and pairing-ticket HTTP
behavior belong in `identity.integration.test.ts`; the setup CLI and browser
handoff belong to the existing product journey in `packages/e2e/setup.e2e.test.ts`.
Related state transitions should advance through one journey instead of rebuilding
the same user, database, and Platform stack in separate cases. The small shared
`support/identity-fixture.ts` starts real
Chat Durable Objects and composes them with the real local Platform. Chat creation
uses production Chat and Platform business operations end to end; only the external
Agent-daemon process is replaced by the shared protocol fake. Narrow peers are
reserved for a boundary behavior that a healthy Platform cannot produce, such as
rejecting an HTTP redirect.
### Mobius

`third-party/mobius/TESTING.md` owns daemon and Agent compatibility testing.
Run **the real daemon with each real supported Agent and its production adapter**:
Codex, Claude Code, OpenCode, and Pi must each have independent coverage for the
behavior they support. Their native APIs, ACP adapters, history, cancellation,
interactions, and session identities can differ. A fake daemon presenting four
Agent labels does not verify those adapters.

Keep the two suites complementary:

| Suite | Real components | Controlled boundary | Owns |
| --- | --- | --- | --- |
| Web / Chat integration and browser journeys | Complete application, router, stores, SDK, Chat, Platform, Runtime relay, transport, storage | Stateful fake daemon | Visible workflows, multiple viewers, reconnect, history, queued work, images |
| Agent-daemon integration | Daemon, production adapter, real Agent executable, native history and filesystem | Model provider may be controlled for deterministic input | Per-Agent execution, streaming, tools, cancellation, queueing, interactions, history and files |

The owned product stack is real except for the daemon in Web / Chat tests.
External identity or model services may use a documented stateful provider when
necessary; that does not authorize replacing a production product layer. Existing
controlled ACP peers are reserved for explicit protocol fault cases that cannot be
produced reliably by a real Agent. They are not the default Agent test boundary
and cannot establish Agent compatibility.

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

Architecture rules are executable in `dependency-cruiser.config.cjs`. Storage and infrastructure cannot
depend on services, HTTP, composition, or gateways; browser and Worker
implementations cannot import each other.

## Scenario ownership map

Web application cases are grouped by user workflow: `identity-handoff`,
`bot-configuration`, `conversation-active`, `conversation-lifecycle`,
`conversation-queue`, and `conversation-content`. Each still renders the complete
application. Shared setup owns teardown; shared actions only operate visible controls.

Mobius controlled cases group native identity, history, authorization, preparation,
and Codex-native commands separately. ACP command/environment, content limits,
usage normalization, and interaction cases each have their own file. Ordinary
first-prompt, continuation, cancellation recovery, and FIFO queue success paths
belong to the real Agent suite. Keep controlled edge cases when their actual
protocol shapes, identities, capabilities, races, or bounds differ; Agent names
alone are not distinct coverage.
