# Browser journeys

This package has one local product stack and two kinds of browser execution.

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

## Agent compatibility

`live` runs the same local product stack with a real third-party Agent connected
to a local fake LLM provider. It proves compatibility with Agent releases; it is
not a second product specification suite.

```bash
pnpm test:compatibility:opencode
pnpm test:compatibility:codex
```

The OpenCode journey runs nightly with the latest release. Shared compatibility
orchestration stays in `live/agent-image.mjs`; Agent files contain only their
installation and configuration differences.
