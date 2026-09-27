# Browser journeys

This package has one local product stack and one browser product suite.

## Product E2E

`conversation.e2e.test.ts` exercises sending a prompt and restoring its history
in a real browser. Chat, Platform, SDK, Runtime relay, daemon, transports, and storage
are real. Its only external replacement is the shared controlled Agent harness,
connected through the production adapter. One Agent profile is sufficient;
this journey does not establish Agent compatibility.

`setup.e2e.test.ts` covers pairing into a different Project and reconnecting a
saved setup identity with a QR handoff. It runs the downloaded production setup
bundle with the controlled harness Runtime's `SetupRuntime` port. It redeems real
Platform tickets, holds pairing credentials, reconnects real WebSockets, and
reports its saved connections through the same local output-file contract.
The production daemon starts a controlled ACP Agent executable for deterministic output.
Native-session import and access revocation are covered by Web application tests.

Run them with:

```bash
pnpm test:e2e
```

Extend one of these journeys before adding another file. Keep business actions and
visible outcomes in the scenario; `infra` owns only startup, credentials, waiting,
diagnostics, and cleanup.

Real third-party Agent, provider, tool-call, ACP, and daemon compatibility belongs
to `third-party/mobius/tests/agent-daemon`. Use the real daemon, real Agent executable, and production adapter there, with
independent coverage for Codex, Claude Code, OpenCode, and Pi. Browser journeys
use the controlled Agent harness to make visible product behavior deterministic; they do not
prove adapter compatibility. A controlled model provider is allowed in daemon
tests without replacing the real Agent. See the root `TESTING.md` for the shared
boundary contract.

Browser-side error branches and state transitions belong to the lightweight full-
application suite in `packages/web/tests`. Keep only the critical successful proof
of those behaviors here; do not add an E2E scenario solely because a Web regression
needs automated coverage. Bot lifecycle, Agent-setting filtering, media rendering,
local-file pulling, and Runtime-agent scoping are owned by that suite. The browser
journey may depend on those behaviors, but does not enumerate them again.
