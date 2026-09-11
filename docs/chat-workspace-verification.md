# Chat workspace verification

Manually exercised with `agent-browser` against
`https://mobius-chat.paradev.biz` in September 2026, using the published
Mobius CLI 0.0.28 and a real paired local Runtime. No browser E2E files or request
interceptors were added.

## Acceptance results

| Given / When | Observable result |
| --- | --- |
| No saved identity / open Chat | Onboarding; no anonymous credential created. |
| First visit / copy the setup instruction | Exact `follow https://mobius-chat.paradev.biz/SKILL.md`; successful copy feedback. |
| Existing unconfigured identity / open Chat | Identity retained; automatic setup waiting; no Reconnect button. |
| Connected identity / open sidebar | Real Codex sessions, including sessions created outside Mobius. |
| Saved native session / open | Existing history and reported model/variant controls restored. |
| Bot composer / change variant and model | Agent-confirmed Medium → Low and GPT-5.6-Sol → GPT-5.6-Terra. |
| Imported session / change variant | Agent-confirmed Low → Medium using the resolved session ID. |
| Imported Bot-backed session / continue | Agent response contains `Native session continuation works.` |
| Independently created local session / continue | Agent response contains `External session continuation works.` |
| Active Bot / select OpenCode and send | OpenCode inventory appears (OpenCode Zen/Big Pickle, Agent default); reply contains `Agent switching works.` |
| Switch back to Codex / send | Codex inventory restored; response `Chat is ready.` |
| 390px mobile viewport / expand sessions and select one | Directory opens, selection collapses it, active entry is marked; native history has no horizontal overflow. |
| Desktop and mobile / inspect onboarding and Chat | Shared controls, responsive layout, copy feedback, readable messages and reachable composer. |
| Another user's Bot / workspace, Runtime access, or binding lookup | HTTP integration scenarios reject access. |

## Fixes found through the live flow

- Existing server credentials need the new `runtime:connect` permission. Staging
  was updated with an audit record.
- An import can resolve to an existing canonical session. The requested temporary
  session may be deleted, so controls must use `ready.sessionId`.
- Continuation needs the canonical session's registered binding and workspace
  representation, resolved inside the user's Project scope.
- Agent switching requires a new behavior proposal and Runtime-local
  authorization before activating a new binding. Each binding gets its own
  conversation; earlier sessions remain discoverable.
- History renders before event replay. Replies use stable command keys and render
  oldest-to-newest, following the newest reply unless the user scrolled upward.
- Mobile sessions collapse to make room for the conversation. Long message text
  wraps within the viewport.

## Delivery scope

Mobius PR #178 supplies the Runtime grants dependency. The Chat branch pins its
published commit. Staging has both components deployed; production deployment and
a fresh full local-agent setup/handoff run are not covered by this verification.
Agents that return a preview instead of a resumable import show an explicit
read-only explanation. Temporary configuration diagnostics were removed.

`pnpm check` passed, including Worker HTTP integration scenarios. Browser checks
used the real staging services and local agents; model inventories and behavior
can vary between agent installations.
