# Browser journeys

This package has one local product stack and one browser product suite.

## Product E2E

`conversation.e2e.test.ts` and `setup.e2e.test.ts` are the executable control
surface for Mobius Chat. They run with Playwright and a deterministic stateful ACP
Agent. Together their few long journeys cross the real Chat, Platform, Mobius,
Runtime, protocol, and browser path.

The setup journey is the sole owner of CLI preparation, pairing, browser handoff,
native-session import, and access revocation. Worker tests cover only the pairing-
ticket HTTP contract; they do not spawn the setup CLI or repeat its local filesystem
matrix.

Run them with:

```bash
pnpm test:e2e
```

Extend one of these journeys before adding another file. Keep business actions and
visible outcomes in the scenario; `infra` owns only startup, credentials, waiting,
diagnostics, and cleanup.

Real third-party Agent, provider, tool-call, ACP, and daemon compatibility belongs
to `third-party/mobius/tests/agent-daemon`. The browser journeys keep a
deterministic ACP Agent and prove one representative image prompt and persisted
Agent response through the Chat-owned side of that boundary.

Browser-side error branches and state transitions belong to the lightweight full-
application suite in `packages/web/tests`. Keep only the critical successful proof
of those behaviors here; do not add an E2E scenario solely because a Web regression
needs automated coverage. Bot lifecycle, Agent-setting filtering, media rendering,
local-file pulling, and Runtime-agent scoping are owned by that suite. The browser
journey may depend on those behaviors, but does not enumerate them again.
