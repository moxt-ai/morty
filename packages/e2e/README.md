# Browser journeys

This package has one local product stack and one browser product suite.

## Product E2E

`conversation.e2e.test.ts` and `setup.e2e.test.ts` are the executable control
surface for Mobius Chat. They run with Playwright and a deterministic stateful ACP
Agent. Together their few long journeys cross the real Chat, Platform, Mobius,
Runtime, protocol, and browser path.

The setup journey is the sole owner of CLI preparation, pairing, browser handoff,
configuration persistence, and reconnect behavior. Worker tests cover only the
pairing-ticket HTTP contract; they do not spawn the setup CLI or repeat its local
filesystem matrix.

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

Browser-side error branches and state transitions belong to the lightweight full-
application suite in `packages/web/tests`. Keep only the critical successful proof
of those behaviors here; do not add an E2E scenario solely because a Web regression
needs automated coverage.
