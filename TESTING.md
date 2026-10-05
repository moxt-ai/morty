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
static and coverage validation when diagnosing CI.

## Test boundaries

Web tests exercise visible user workflows in happy-dom. Worker tests enter through
production HTTP, WebSocket, and storage boundaries. Browser E2E covers happy-path
conversation and setup journeys.

Morty Web, Worker, and browser suites connect a stateful fake daemon through the
real Platform WebSocket endpoint. Chat, Platform, SDKs, and transports remain real.
Morty does not start the production daemon or a controlled ACP Agent. Each fixture
owns pairing and cleanup of the resources it creates.

Follow [AGENTS.md](AGENTS.md) for scenario and fake-provider rules. Exercise visible
controls in Web tests and production HTTP/WebSocket boundaries in Worker tests.
Real Agent compatibility requires the real executable and production adapter;
a controlled provider can supply deterministic model responses without coding-plan
credentials. Do not infer compatibility from an Agent label on a controlled peer.

Hosted sign-in and visual layout checks remain manual. Dated reports under
`artifacts/` are evidence of a particular run, not current design specifications.
