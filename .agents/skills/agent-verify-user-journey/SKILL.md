---
name: agent-verify-user-journey
description: Run Morty's complete local Chat and Platform stack, pair a selected agent harness as a Runtime, ask it through the browser UI to build a disposable web app, then verify the app's user journey with a selected browser and retain screenshots. Use for prompts such as "use Codex, GPT 5.5, and agent-browser to verify a todo app."
---

# Agent User-Journey Verification

Verify the real Morty product boundary. Start the local Chat Worker and local
Platform, pair the selected harness as a Runtime, and ask the agent to build the
app through Morty's browser UI. Then run the generated app and exercise it with
a real browser.

**Never invoke the selected harness directly.** In particular, do not use
`codex exec`, `claude`, or another harness CLI to generate the app. The harness
must receive the task through the paired Runtime and Morty Session flow so this
journey verifies the local Workers, Platform relay, live events, and UI as well
as the agent itself.

Load and follow `chat-local-full-dev` for local-stack setup, Runtime connection,
identity handoff, logs, and teardown. Its safety constraints are part of this
skill.

## Resolve the request

Resolve these inputs before starting:

| Input | Default | Selection rule |
| --- | --- | --- |
| Harness | `codex` | Use the harness the user names; otherwise use `codex`. |
| Native session ID | none, required | Read the exact current session ID from the selected harness's own session metadata. Never guess, reuse a default, or substitute another harness's session. |
| Model | `gpt 6.1 sol` | Use the model the user names; otherwise use `gpt 6.1 sol`. |
| Browser | session-attached browser, then headed `agent-browser` CLI | Honor a user-specified browser first. Otherwise use the browser attached to the current session when one exists; fall back to an installed `agent-browser` CLI running in the foreground. |
| App | to-do-list web app | Preserve any app or journey requirements supplied by the user. |

Treat names in example requests as parameters, not fixed requirements. Do not
silently substitute a different harness, model, or explicitly requested
browser. Confirm that the selected browser is available. Resolve and select the
requested model through Morty's visible Session configuration controls; do not
probe it by running the harness directly. If the requested model cannot be
selected unambiguously in Morty, stop and ask the user rather than guessing.

## Prepare isolated paths

Resolve the repository directory from which the user invoked the skill and
retain it as `<original-cwd>`. Confirm it is a compatible Morty checkout as
required by `chat-local-full-dev`, and preserve all existing changes.

Create these locations without overwriting existing content:

- App workspace: a randomized directory under `~/Documents/tmp/`. Create the
  parent directory if needed, then use
  `mktemp -d "$HOME/Documents/tmp/agent-verify-user-journey.XXXXXX"`.
- Local-stack state: a separate randomized directory under the approved system
  temporary root. Never put local Worker state in the app workspace.
- Evidence: `<original-cwd>/test-results/agent-verify-user-journey/<run-name>/`.

Never initialize or modify the generated app inside the repository. Do not
include credentials, user data, handoff links, or private configuration in the
app or screenshots.

## Start the local stack and connect the Runtime

Use `chat-local-full-dev` to:

1. Validate the checkout, pinned Node and pnpm versions, dependencies, and the
   `third-party/mobius` submodule revision.
2. Start an isolated local stack in `web-server` mode. This must include the
   local Chat Worker, its Durable Objects/queues/R2/assets, and the local
   Platform fixture. Read `chatOrigin`, `platformOrigin`, and `stateDir` from
   the ready/status record; do not assume ports.
3. Check stack health before opening the browser.
4. Connect the selected harness as a Runtime with the required harness and
   session identifiers:

   ```sh
   node scripts/local-dev.cjs setup \
     --state-dir <stateDir> \
     --harness <selected-harness> \
     --session-id <exact-native-session-id> \
     --workspace <app-workspace>
   ```

   Both `--harness` and `--session-id` are required; `setup` rejects a missing
   value instead of falling back to one. Resolve the harness from the request
   and never substitute another harness. `--session-id` must name a native
   session that already exists for that harness, because the Continue page opens
   it by importing it; a fabricated identifier fails there instead of opening
   the Chat page. Resolve it from the selected harness's own current session
   metadata; do not ask the user for it, guess, or reuse a default.

5. Capture the setup result to a protected temporary file rather than printing
   it into the conversation. `handoffUrl` carries a one-time transfer code, so
   treat it as a secret.

Connecting the harness launches it as a Runtime; it does not authorize calling
the harness CLI directly for generation.

## Ask the agent through Morty

Open `handoffUrl` from the setup result in the selected browser; never preview
or redeem it from the setup side. The Continue page redeems the transfer code,
keeps the identity, and opens the native session named by `sessionId` in Morty,
so do not seed storage or use browser internals to manipulate application state
after setup.

Through visible Morty controls:

1. Confirm the agent configuration shows the paired harness; the page serves the
   Bot bound to it, so there is no Bot selector.
2. Select the exact requested model in the Session configuration.
3. Start a new conversation with the **New Session** control.
4. Send an outcome-focused build request that names the already-paired app
   workspace and asks the agent to provide exact local install and loopback-only
   start commands when it finishes.

Unless the user supplied different requirements, require a locally runnable
to-do app in which a user can:

1. See an explicit empty state.
2. Add a named item.
3. Mark the item complete and visibly see its completed state.
4. Delete the item and return to the empty state.

While that build turn is visibly active, exercise the live message controls
through the UI rather than waiting for completion:

1. Submit a concise follow-up that changes an observable app requirement. Verify
   it appears in **Queued messages** instead of starting another turn.
2. Use that queued message's **Steer** action. Verify it leaves the queue and the
   active turn visibly accepts it. The final app must include the steered
   requirement.
3. Submit a second follow-up with a harmless, uniquely observable requirement.
   Verify it appears in **Queued messages**, then use its **Delete** action before
   the active turn finishes. Verify the queued entry disappears and the final
   app does not include that deleted requirement.

Choose follow-ups that are deterministic and safe to verify. For example, steer
the agent to use a distinctive visible heading, then queue and delete a request
for a second distinctive footer. Do not make timing assumptions: if the initial
turn finishes before all three controls are exercised, the control journey has
failed and must not be reported as verified. Do not slow or alter the Runtime
through internal APIs to keep the turn active.

Wait for the visible turn to complete through live Session events. Confirm in
the UI that the selected model handled the turn and capture the final response
with its run commands. Do not infer success merely from files appearing in the
workspace, and do not bypass Morty by querying the daemon or Platform directly.

If generation fails, retain the browser-visible failure and inspect the local
stack logs using `chat-local-full-dev`. Report the failure; do not repair the
app unless the user explicitly requests a repair attempt. Keep initial-failure
evidence distinct from any later repaired result.

## Start and inspect the generated app

Inspect the generated files only after the Morty turn completes. Validate the
agent-provided commands before running them: they must be local development
commands and must not deploy, publish, read credentials, escalate privileges,
or access unrelated paths.

Run the provided install command if needed, then start the app bound to
loopback. Use the server's reported URL rather than assuming a port. Keep
ownership of the app server process and stop it on success, failure, or
cancellation.

If the app cannot install, build, or start, report that as the verification
result without changing its source.

## Verify with the selected browser

Use browser precedence exactly as resolved above. For an attached browser, use
an explicit tab ID for every operation. For `agent-browser`, load its installed
core skill/help first, create a dedicated named session, launch its first `open`
command with `--headed`, and reuse that same visible foreground session for
every command. Do not run the verification journey in a headless browser.

Open the generated app's loopback URL and exercise it only through visible
controls, labels, and text. Do not call app internals, mutate storage directly,
or treat a successful page load as proof of the full journey. Verify every
requested state and check browser-visible errors and console failures relevant
to the journey.

## Retain visual evidence

Screenshot the behavior the user actually asked to verify, at the product
boundary where that behavior is visible. Do not automatically use screenshots
of the generated to-do app as evidence for a Morty, Platform, Runtime, or
streaming fix.

For example, a streaming fix needs screenshots of the Morty conversation while
the turn is still active: one showing partial reasoning and another showing a
partial assistant message before completion. A queue-control fix needs the
relevant queued, steered, or deleted state in Morty. Capture generated-app
states only when the generated app journey itself is the requested behavior.

Capture each required state through normal browser actions. Name files after
the behavior they prove, for example:

```text
test-results/agent-verify-user-journey/<run-name>/
  01-partial-reasoning.png
  02-partial-assistant-message.png
  03-turn-completed.png
```

Use the smallest set that proves the requested journey, but retain multiple
screenshots when states differ. Do not place evidence in the generated app
workspace or local-stack state directory. Never capture credentials, handoff
links, or private configuration.

## Cleanup

Unless the user explicitly asks to leave services running:

1. Stop the generated app server.
2. Close the dedicated browser session or tab.
3. Remove the local stack with
   `node scripts/local-dev.cjs remove --state-dir <stateDir>`.

Keep the generated app workspace and repository evidence. Cleanup must never
remove `test-results/`.

## Report the result

Return:

1. Selected harness, exact model identifier shown in Morty, and browser.
2. Local Chat and Platform origins, whether the paired Runtime connected, and
   whether the stack was stopped or intentionally left running. Never report
   identity tokens or handoff links.
3. Randomized app workspace path and validated install/start commands.
4. Pass or fail for the Morty generation turn, queue, steer, queued-message
   deletion, and every app journey step.
5. Repository-relative screenshot paths.
6. Any generation, Worker, Platform, Runtime, install, server, browser, or app
   failure, including relevant typed error codes when available.

Do not call the journey verified unless the task traveled through Morty's local
browser UI and paired Runtime, the visible turn completed with the requested
model, queue/steer/delete were visibly exercised during the active turn, and the
selected browser completed every requested app interaction.
