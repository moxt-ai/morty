# Browser journeys

This package has one local product stack and one browser product suite.

## Product E2E

`conversation.e2e.test.ts`, `claude-conversation.e2e.test.ts`,
`pi-conversation.e2e.test.ts`, and `setup.e2e.test.ts` are the executable control
surface for Morty. The intended boundary uses Playwright with the real Chat,
Platform, SDK, Runtime relay, transports, and storage, replacing only the local
daemon with a stateful fake at its production protocol port.

Current infrastructure still uses a real daemon with a controlled ACP Agent.
Convert that infrastructure to the fake-daemon boundary; do not extend this older
composition or describe it as real Agent coverage. Agent-named journey files are
not evidence that their real binaries or adapters were tested.

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
to `third-party/mobius/tests/agent-daemon`. Use the real daemon, real Agent executable, and production adapter there, with
independent coverage for Codex, Claude Code, OpenCode, and Pi. Browser journeys
use the fake daemon to make visible product behavior deterministic; they do not
prove adapter compatibility. A controlled model provider is allowed in daemon
tests without replacing the real Agent. See the root `TESTING.md` for the shared
boundary contract.

Browser-side error branches and state transitions belong to the lightweight full-
application suite in `packages/web/tests`. Keep only the critical successful proof
of those behaviors here; do not add an E2E scenario solely because a Web regression
needs automated coverage. Bot lifecycle, Agent-setting filtering, media rendering,
local-file pulling, and Runtime-agent scoping are owned by that suite. The browser
journey may depend on those behaviors, but does not enumerate them again.
