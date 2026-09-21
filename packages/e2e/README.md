# Browser journeys

This package has one local product stack and one browser product suite.

## Product E2E

`conversation.e2e.test.ts` and `setup.e2e.test.ts` are the executable control
surface for Mobius Chat. They run with Playwright and a deterministic stateful ACP
Agent. Each file is one long journey through the real Chat, Platform, Mobius,
Runtime, protocol, and browser path.

Run them with:

```bash
pnpm test:e2e
```

Extend one of these journeys before adding another file. Keep business actions and
visible outcomes in the scenario; `infra` owns only startup, credentials, waiting,
diagnostics, and cleanup.

Real third-party Agent, provider, tool-call, ACP, and daemon compatibility belongs
to `third-party/mobius/tests/agent-daemon`. The browser journeys keep a
deterministic ACP Agent and prove the Chat-owned side of that boundary, including
media rendering and on-demand local-file transfer.
