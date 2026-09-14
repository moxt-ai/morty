# Testing Guide

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

Given an open Bot conversation or continued local Session, When an agent streams
a reply, Then text appears incrementally without a message/history snapshot GET
for each text or activity event. When the turn finishes, Then its final response
and status match the saved history. When the conversation is idle, Then no
five-second message/history polling continues. Inspect Fetch/XHR in DevTools;
the persistent `events` request is the SDK's SSE connection.
Given an interrupted event connection, When the SDK reconnects and replays events,
Then the reply contains each text delta once. Given exhausted stream recovery,
Then Chat shows a connection failure instead of silently remaining live.

Do not add automated E2E test files. Verify the user journey manually with the
`agent-browser` CLI against the running application. A first-time visitor should
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
