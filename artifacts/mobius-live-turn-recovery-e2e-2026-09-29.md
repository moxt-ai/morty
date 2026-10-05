---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Mobius live Turn recovery E2E — 2026-09-29

## Scenario

Given Morty is paired to the production Mobius daemon and a stateful controlled ACP Agent,
when a user completes one Turn, reloads it, starts a second Turn that pauses after its first text and content deltas, and opens that running Session in a second browser page,
then both pages show one consistent reply, the recovered rich content, and the same stoppable running state.

After this, a user can reopen a running conversation in another page and see the complete available reply and attachment without duplicated terminal output.

## Verification

- Mobius submodule: `dfd8846578e8bbdde23ea92c56c90808d12f03b5`
- Completed history reload rendered exactly one `Codex turn 1: First conversation` response.
- Both pages rendered exactly one `Partial reply` response and `partial.bin` while the second Turn was running.
- The second page exposed `Stop agent output` and stopped the real daemon Turn.
- Both pages left the running state and retained the partial text after cancellation.
- The Web integration scenario separately recovered exactly 300,000 streamed characters plus `long-output.bin` across all native-history pages.

## Repeat

```sh
pnpm sync:submodules
pnpm --filter @moxt-ai/morty-web exec vitest run --config vitest.config.ts conversation-active.integration.test.tsx
pnpm --filter @moxt-ai/morty-e2e exec playwright test conversation.e2e.test.ts --grep 'live and completed replies remain consistent'
```

The Playwright run writes the same three screenshots under its test-results directory. This checked-in artifact retains the passing run:

- `mobius-live-turn-recovery-e2e-2026-09-29/active-turn-primary.png`
- `mobius-live-turn-recovery-e2e-2026-09-29/active-turn-secondary.png`
- `mobius-live-turn-recovery-e2e-2026-09-29/completed-turn-secondary.png`

Result: pass.
