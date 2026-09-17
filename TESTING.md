# Testing Guide

## Required quality gate

`pnpm check` includes `pnpm check:architecture` and `pnpm test:coverage`.
The coverage command runs both Worker and web suites, then merges their Istanbul
execution maps into `coverage/lcov.info`, `coverage/coverage-summary.json`, and an
HTML report in `coverage/`. It reports an informational 95% target for lines,
statements, functions, and branches using exact covered/total counts. A failing
suite or missing or empty suite report fails the command; unmet coverage targets do not.

Scope includes unexecuted production `.ts` and `.tsx` in both packages. Tests,
stateful test fakes, declarations, and the generated `routeTree.gen.ts` are excluded.
The Mobius submodule has its own report and informational 100% target. Code executed only in a
separate subprocess or externally bundled Worker is not credited by the parent
runner; its source remains in the denominator until instrumented coverage exists.

On pull requests and merge-queue events, CI installs the workspace once for static
verification and once for tests. The `static` job runs type checking, build,
lint/architecture, unused-code checks, and local D1 migration validation. The `tests`
job runs the web and Worker suites once, merges their execution maps, and saves the
combined report as a non-blocking `coverage-report` artifact for 14 days. Run the
suites separately with `pnpm test:web` and `pnpm test:worker`. The required `check`
status only combines the two job results; it does not check out the repository or
install dependencies again.

Main pushes and manual deployments skip these checks and deploy after Worker
configuration validation; checks are not repeated after merging.

## Architecture enforcement

`pnpm check:architecture` resolves TypeScript imports, including type-only imports,
and checks dependency direction. Shared Slack records and event schemas belong in
`components/slack/entity`; storage and infrastructure cannot import services,
composition, HTTP, or gateways. Browser and Worker implementations cannot import
one another. See `dependency-cruiser.config.cjs` for the executable rules.

These boundaries apply the information-hiding approach in
[Business logic decomposition patterns](https://github.com/taowen/modularization-examples).
Private persisted records stay with their storage owner; shared records describe
the contract consumed by storage and services. Reuse requires an explicit purpose
and applicability scope. Interface churn and state visibility inform design review;
the checker enforces the concrete dependency directions.

## Executable Product Specifications

Deliver each behavior change as the smallest end-to-end path a user can run and observe. Before implementation, state the slice in one sentence:

> After this, a user can ... and see ...

The slice should cross the necessary input, runtime, adapter, and output boundaries. Do not build complete horizontal layers that provide no runnable behavior. Extend the existing working path and implement only what the current slice requires.

Behavior changes start with a failing BDD acceptance scenario before production code changes. The scenario must fail because the promised behavior is absent, prove the slice through the first supported product boundary that can observe it, and pass after the smallest implementation of that behavior. Add narrower scenarios afterward only for distinct boundary-owned risks.

BDD scenarios are executable product specifications and the living documentation of supported behavior. Every test title uses this form:

```text
Given [observable context], When [an actor performs an action], Then [an observable result occurs]
```

User-path titles describe product behavior in domain language. Protocol and external-boundary titles describe the contract owned by that boundary. Keep fixtures, helpers, framework terminology, internal modules, and implementation details out of titles and in the test body.

Documentation-only changes and mechanical refactors with no behavior change do not need new tests.

## Test Scope

Give each supported product promise one primary acceptance scenario and each boundary contract one primary owning test at the boundary that provides the clearest stable failure. Add a narrower test or repeat an invariant at another level only when it covers a distinct high-impact risk or delivery failure, such as authorization, destructive side effects, data integrity, protocol compatibility, cancellation, or resource cleanup.

Do not test repository tooling or scaffolding. This includes CI workflows, lint and formatter configuration, Git hooks, dependency-management configuration, build scripts, and other development-only automation. Verify those concerns by running the tools themselves. Do not test third-party library behavior or add tests solely to increase coverage.

## Required Test Levels

Critical user paths must use end-to-end tests. Protocols and external boundaries must use integration or contract tests. End-to-end tests exercise supported public entrypoints; integration and contract tests exercise the production boundary contract. Use production components together with real temporary filesystems, subprocesses, sockets, and local protocol servers where the product path requires them.

A lower-level test is not acceptance if the supported user path could break while the test still passes. Boundary tests may support a slice, but they cannot replace its user-visible acceptance scenario.

Unit tests are prohibited by default. The default Vitest configuration only
discovers `*.contract.test.ts`, `*.integration.test.ts`, and
`*.e2e.test.ts`. Renaming an isolated helper or class test does not make it a
boundary test: move the assertion to the owning protocol, runtime, or product
entrypoint, or remove it when a stronger scenario already owns the behavior.

Assert observable contracts, including returned results, emitted events, protocol messages, state transitions, filesystem effects, process exit status, and typed errors.

Do not write isolated tests for private helpers, internal control flow, incidental ordering, or implementation details. Do not assert that an internal collaborator was called. A refactor that preserves the product contract should not break the test.

Except for the deterministic fake timers required below, mocks are prohibited. Do not use mock functions, mocking frameworks, spies, stubs, monkey patching, module replacement, or canned request interceptors.

When a real external harness or provider cannot be used safely or deterministically, a stateful fake injected through the production port is the only permitted substitute. Keep the fake at that external boundary, make it implement the real contract instead of returning per-test canned answers, and explain why the real dependency cannot be used. Do not add test-only branches or hooks to production code.

## Deterministic Time

Tests involving time must use fake timers with an explicit fixed system time and restore timer state during cleanup. Advance the fake clock explicitly to exercise deadlines, retries, heartbeats, and cancellation.

Do not use real sleeps, polling delays, implicit `Date.now()` values, or timing tolerances. Time-sensitive production code must accept a clock or timer dependency at its real boundary so tests can inject deterministic time. Do not replace time with any other mocking mechanism.

For an operation that owns resources, test observable cleanup after success, failure, timeout, and cancellation when those outcomes are reachable. Retry tests must prove the attempt limit, cancellation during backoff, and the rule that unsafe or indeterminate operations are not retried. Error-contract tests assert stable codes and sanitized boundary messages, not incidental infrastructure wording.

Coverage identifies untested code but does not decide which tests to write. Do not create impossible typed states or duplicate tests merely to increase coverage. If a branch is unreachable under current invariants, remove or simplify it. Cover critical user paths with end-to-end tests and protocol or external boundaries with integration or contract tests.

## Authentication verification

Run `pnpm test` for the Worker HTTP contract scenarios. They use an in-memory
identity provider that issues real RSA-signed session tokens, with an explicit
fixed clock. No live Clerk account or credentials are required in CI.

Clerk's hosted sign-in and sign-up flows are checked manually; this project
does not automate those flows with Playwright. Open the app, confirm both
account dialogs are available, and verify that an account can sign in, see its
bots, Chat, Slack integration, and sign out when manually validating an auth change.

## Browser verification

Chat browser E2E tests and their shared fixtures live in `packages/e2e`. Run
`pnpm test:e2e` to execute all of them with Playwright Test and real Chrome.
The TypeScript scenarios receive a `runtime` fixture from `infra/test.ts`.
`createTestRuntime` owns agent setup, the local stack, browser startup, instruction
execution and deterministic setup timers; the fixture owns diagnostics and cleanup.
Scenarios describe user actions and assert visible results. The package's strict
TypeScript check is included in `pnpm check`.
The setup scenarios cover both
instruction journeys. After this, a user can follow `pair.md` or `setup.md`, enter
the paired Bot's Chat view, send a prompt, and see the agent reply and saved history.
The scenarios fetch the rendered document and generated bundle from the local
Worker/R2 boundary, then execute the bundle's `runSetup` entrypoint with a real,
isolated Runtime subprocess. Pair preserves the browser's original Bot and Project;
standalone setup opens its five-use browser handoff, finds the supplied harness session
by its native ID, emits a private PNG and terminal QR containing the exact handoff URL,
returns a forked continuation, and displays its history. The setup acceptance scenario
decodes the PNG instead of relying on a file-existence or screenshot assertion. Both reload
the connected Chat view without re-pairing, send a prompt, reload its saved conversation
or Session, and send a follow-up that receives a fresh reply in the same context.
Agent inference uses the stateful ACP test agent; Platform provisioning uses the
shared local developer-authentication fixture. The browser still loads Clerk's
hosted SDK, so the suite requires internet access but no Clerk login. Setup
waits use explicitly advanced fake timers with a fixed system time.

These tests require Chrome and the checked-out Mobius submodule. They share the
local-stack runner and diagnostics used by the conversation scenarios. Playwright
global setup builds Mobius, Chat, and the setup bundle once before three workers
run individual journeys in parallel, including scenarios in the same file. Each
journey owns temporary storage, Runtime state, dynamic HTTP and inspector ports,
and its browser. Run these journeys locally with `pnpm test:e2e`; failed journeys
retain their own diagnostics directories. The `Verify browser journeys` job is no
longer scheduled in CI. HTTP integration
coverage additionally runs the TypeScript CLI as a subprocess to verify identity
reuse, ticket consumption, private configuration, and Runtime replacement failures.

Given an open Mobius Session, including one imported or forked from a native session, When an agent streams
a reply, Then text appears incrementally without a message/history snapshot GET
for each text or activity event. When the turn finishes, Then its final response
and status match the saved history. When the conversation is idle, Then no
five-second message/history polling continues. Inspect Fetch/XHR in DevTools;
the persistent `events` request is the SDK's SSE connection.
Given an interrupted event connection, When the SDK reconnects and replays events,
Then the reply contains each text delta once. Given exhausted stream recovery,
Then Chat shows a connection failure instead of silently remaining live.
Given a Session command whose delivery cannot be confirmed, Chat retains its command ID,
shows **Delivery unknown** after reload, and only retries after the user chooses the retry.
Given a browser that redeemed a setup entry, ending remote access revokes that entry and
every credential redeemed from it while the owner's local identity and Runtime remain active.

Run `pnpm test:e2e:opencode` for the live OpenCode browser journey. It is excluded
from local `pnpm check` and PR/merge-queue CI and runs nightly in GitHub Actions.
It uses the latest OpenCode release with a local fake LLM provider.
Verify other visual details
manually with the `agent-browser` CLI against the running application. A first-time
visitor should
receive a browser-held anonymous identity and Bot, then see a current-origin
`follow .../pair.md?token=...` instruction. After local-agent pairing, the same page
opens headerless Chat without Project controls or Slack navigation. Reload and
confirm the same identity and Bot are retained. No web instruction points to
`setup.md`; verify its browser handoff separately as the externally shared flow.
Given a previously paired workspace whose selected Runtime is offline, When the
user revisits Chat with their saved identity, Then the page explains that the
selected agent is offline, asks them to restart it, and says it checks automatically
every five seconds. The pairing instruction remains available for recovery.
Given a workspace whose selected agent is no longer available, When the user
revisits Chat, Then the page explains that the selected agent is unavailable and
offers pairing instructions. If the Bot is inactive, the page explains that instead.
Reconnect the selected Runtime and confirm the same page opens Chat automatically.
HTTP integration tests cover identity creation, Bot ownership, and authorization.

### New conversation drafts

Given a paired workspace, When the user opens Chat or clicks New Conversation,
Then the composer opens a local draft with Harness to the left of Model. Loading
the model inventory may prepare a temporary settings Session, which is deleted
after preparation; it must not create a Conversation or issue Conversation access.

Given a draft with a selected harness, model, and prompt, When the user sends,
Then a new Conversation is created with that configuration and the prompt is
submitted. Harness becomes disabled while Model remains editable. Reload the
resulting URL and confirm the same Conversation and history reopen. Click New
Conversation again and confirm Harness is editable and the next send creates a
distinct Conversation. Verify with `agent-browser` and the browser network log.

`pnpm test:e2e` also covers the conversation browser regression against local Chat,
Platform and Runtime with the stateful ACP test agent. First Send must retain the
page and composer while the draft becomes a conversation and the reply appears.
The scenario also creates a distinct second conversation, sends a follow-up and
reloads its saved URL to verify history.
