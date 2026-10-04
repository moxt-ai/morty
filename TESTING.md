# Testing

## Commands

```sh
pnpm lint
pnpm typecheck
pnpm test:web
pnpm test:worker
pnpm test:e2e
```

Run only related suites during development. `pnpm ci:check` reproduces combined
static and coverage validation when diagnosing CI. Commands and CI membership are
owned by [package.json](package.json) and [CI](.github/workflows/ci.yml).
Coverage generation is implemented in [coverage.mjs](scripts/coverage.mjs).

## Composition and scenario owners

| Suite | Assembly | Scenarios |
| --- | --- | --- |
| Web / happy-dom | [test app](packages/web/tests/infra/test-app.tsx), [Chat stack](packages/web/tests/support/chat-worker.ts) | [Web workflows](packages/web/tests/) |
| Worker / local Cloudflare | [identity fixture](packages/worker/tests/support/identity-fixture.ts) | [HTTP and WebSocket boundaries](packages/worker/tests/) |
| Browser / Playwright | [runtime](packages/e2e/infra/test-runtime.ts), [local stack](packages/e2e/infra/local-stack.ts) | [conversation](packages/e2e/conversation.e2e.test.ts), [setup](packages/e2e/setup.e2e.test.ts) |
| Real Agent compatibility | [Mobius test guide](third-party/mobius/TESTING.md) | [real Agent scenarios](third-party/mobius/tests/agent-daemon/real/) |

Morty Web, Worker, and browser suites connect the [stateful fake daemon](tests/support/fake-daemon/peer.ts)
through the real Platform WebSocket endpoint. Chat, Platform, SDKs, and transports
remain real. Morty does not start the production daemon or a controlled ACP Agent.
The [Platform fixture](packages/worker/tests/support/test-platform.ts) owns pairing
and fake daemon cleanup; browser setup uses the same fake daemon transport.

Follow [AGENTS.md](AGENTS.md) for scenario and fake-provider rules. Exercise visible
controls in Web tests and production HTTP/WebSocket boundaries in Worker tests.
Real Agent compatibility requires the real executable and production adapter;
a controlled provider can supply deterministic model responses without coding-plan
credentials. Do not infer compatibility from an Agent label on a controlled peer.

Hosted sign-in and visual layout checks remain manual. Dated reports under
`artifacts/` are evidence of a particular run, not current design specifications.
