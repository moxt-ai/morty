# Browser journeys

Run `pnpm test:e2e` from the repository root.

- [Conversation](conversation.e2e.test.ts): real-browser conversation and recovery.
- [Setup](setup.e2e.test.ts): pairing and browser handoff.
- [Assembly](infra/test-runtime.ts): local product stack and test resources.

See [Testing](../../TESTING.md) for suite ownership. Keep business actions visible
in scenarios; `infra` owns startup and cleanup. Agent compatibility belongs to
[Mobius real Agent tests](../../third-party/mobius/tests/agent-daemon/real/).
