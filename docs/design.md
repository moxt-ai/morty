# Mobius Chat design

## Product flow

After this, a first-time visitor can copy a setup instruction into their local
agent and see how to return to their connected Chat. A returning user can open
their saved identity, choose a local agent, model and variant, and browse their
local sessions without a manual reconnect step.

- No identity: create a browser-held anonymous identity and personal Bot before
  showing the pairing instruction. No sign-in is required.
- Every web workspace: `follow <current Chat origin>/pair.md?token=...`.
  The one-time ticket connects the existing user and Bot; the agent directs the user
  back to the same web page after the Runtime's execution binding is approved.
- External sharing and testing: `follow <current Chat origin>/setup.md`.
  This standalone flow returns a one-time browser handoff and is not shown in the web UI.
- Saved identity: validate and restore automatically. Loading, unconfigured Bot,
  offline Runtime, and failed requests are distinct states.
- On entry, show the pairing instruction whenever the Bot has no active binding
  or its selected Runtime/agent is offline. Recheck connection status and open Chat
  automatically when that binding becomes active and online.
- Local sessions belong in the left rail. Selection opens the corresponding
  session; do not substitute fabricated sessions or models for missing inventory.
- Agent, model and variant choices come from the Runtime and SDK. A configuration
  request is pending until the agent reports the applied value.

## Visual tokens

Use existing semantic Tailwind tokens and shared Radix-based controls.

| Role | Token / treatment |
| --- | --- |
| Canvas | `bg-background`, quiet neutral surface |
| Raised surface | `bg-card`, `border-border`, subtle shadow |
| Secondary surface | `bg-muted/30` |
| Main text | `text-foreground` |
| Supporting text | `text-muted-foreground` |
| Primary action | Existing primary button, forest-green accent |
| Selection | `bg-accent`, text plus icon, never color alone |
| Error | `text-destructive`, descriptive recovery action |
| Spacing | 4px base; 8/12px controls, 16/24px groups, 32/48px sections |
| Radius | 8px controls, 16px cards, 24px composer |
| Type | System sans; 14px controls, 16px body, fluid 32–48px onboarding title |

## Layout

Onboarding uses one focused panel: product identity, outcome-led heading, a
copyable instruction, and three steps (copy, run in local agent, open handoff).
Explain that the agent runs on the user's machine and must stay running.

Chat uses a 256px session rail, a flexible conversation canvas, and a bottom
composer capped at a readable width. Group agent/model/variant controls with the
composer. Keep message history scrollable and controls reachable on small screens.
Empty states offer the next useful action; they never look like request failures.

## Motion and interaction

- 150–200ms color, opacity and transform transitions for controls and panels.
- Subtle entry animation, no looping decorative movement or layout jumps.
- Respect `prefers-reduced-motion`; disable nonessential animation/transforms.
- Copy reports success or a selectable-text fallback on clipboard failure.
- Preserve drafts and selected sessions through background inventory updates.
  Explicit directory refresh returns to Bot Chat while reopening the connection.
- Keyboard-visible focus, labelled controls, polite status announcements, and
  explicit error messages. Avoid announcing the entire history on each refresh.

## Acceptance scenarios

1. Given no saved identity, when a visitor opens Chat, then onboarding displays
   the current-origin instruction and creates no anonymous identity.
2. Given a valid saved identity, when Chat opens, then it restores automatically;
   an unconfigured Bot displays setup guidance within Chat rather than Reconnect.
3. Given Runtime inventory, when a user chooses agent/model/variant, then the
   actual selection is applied and visible, including pending/error states.
4. Given local sessions, when the user selects a sidebar entry, then its history
    opens without crossing user or Runtime ownership boundaries.
5. Given an import resolves to an existing session, when the user changes settings
   or sends a message, then Chat uses the canonical session and registered binding.
6. Given an active Bot, when the user chooses another agent, then a new behavior
   proposal is submitted for Runtime-local authorization and an approved binding
   opens its own Bot conversation.

## Runtime integration

The Worker keeps AppCredential server-side and uses the Project SDK for native
session listing/import. After selection, it issues a short-lived credential scoped
to the resolved Session. The browser communicates directly with Mobius for history,
turns, configuration and events. Bot messaging keeps its existing conversation
credentials. No Runtime-wide host credential is sent to the browser; the Runtime
remains the authority for local execution.
