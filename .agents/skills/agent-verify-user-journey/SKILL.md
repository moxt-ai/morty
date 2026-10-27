---
name: agent-verify-user-journey
description: Start Morty's local Chat and Platform stack with --mode=initial|paired|todolist (default todolist). Open the unpaired setup page, pair a selected harness and open its handoff, or verify an agent turn and live message controls through Morty's browser UI. Generated-app correctness is out of scope.
---

# Agent User-Journey Verification

Verify the real Morty product boundary at the requested stopping point. Start
the local Chat Worker and local Platform in every mode. Depending on `--mode`,
open the initial setup page, pair a Runtime and open its handoff, or continue
through an agent task and live message controls in Morty's browser UI. Verify
the agent integration, not the correctness of the work the agent produces.

**Invoke the selected harness directly only for setup and pairing.** Ask Codex,
Claude Code, or Pi to run the isolated local setup command below from its own
native session. Do not use `codex exec`, `claude`, or another harness CLI to
generate the app. The harness
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
| Mode | `todolist` | Accept `--mode=initial`, `--mode=paired`, or `--mode=todolist`. Reject other values before starting services. |
| Harness | `codex` | Use the harness the user names; otherwise use `codex`. |
| Native session ID | resolved by the selected harness during pairing | Ask the selected harness to use its own current session metadata or session environment variable. Never guess, reuse a default, or substitute the verification agent's session. |
| Model | `gpt 5.6 terra`, fallback `deepseek v4.1 flash` | Honor an explicit user choice without substitution. Otherwise select `gpt 5.6 terra`; if unavailable in Morty, select `deepseek v4.1 flash`. |
| Browser | session-attached browser, then headed `agent-browser` CLI | Honor a user-specified browser first. Otherwise use the browser attached to the current session when one exists; fall back to an installed `agent-browser` CLI running in the foreground. |
| App | to-do-list web app | Preserve any app or journey requirements supplied by the user. |

### Mode boundaries

`--mode` is an argument to this skill, not a flag to `local-dev.cjs`.

- `initial`: prepare and health-check the local stack without pairing a Runtime,
  then open `<chatOrigin>/setup` in the selected browser. Stop at the visible
  initial setup page. Do not run `local-dev.cjs setup`, resolve a native session,
  select a model, or generate an app.
- `paired`: prepare and health-check the local stack, pair the selected harness
  with `local-dev.cjs setup`, then open its returned `handoffUrl` in the selected
  browser. Let the Continue flow finish and confirm the paired session opens.
  Stop there; do not select a model, start a new conversation, or generate an app.
- `todolist` (also when `--mode` is omitted): run the complete existing journey,
  including pairing, model selection, app generation, queue/steer/delete controls,
  and visible turn completion. The name identifies the default agent task;
  installing, starting, or testing the generated app is out of scope.

For `initial`, only resolve the mode and browser. For `paired`, also resolve the
harness; that harness resolves its native session during pairing. Model and app inputs apply only to `todolist`.
Setup-only modes intentionally leave the healthy stack and browser open for the
user; see Cleanup for failure handling and explicit teardown requests.

Treat names in example requests as parameters, not fixed requirements. Do not
silently substitute a different harness, model, or explicitly requested
browser. Confirm that the selected browser is available. In `todolist`, resolve and select the
requested model through Morty's visible Session configuration controls; do not
probe it by running the harness directly. Use the fallback only when no model
was explicitly requested and the default is unavailable. If neither default nor
fallback, or an explicitly requested model, can be selected unambiguously in
Morty, stop and ask the user rather than guessing. Report the exact model selected.

## Prepare isolated paths

Resolve the repository directory from which the user invoked the skill and
retain it as `<original-cwd>`. Confirm it is a compatible Morty checkout as
required by `chat-local-full-dev`, and preserve all existing changes.

Create these locations without overwriting existing content:

- App workspace (`paired` and `todolist` only): a randomized directory under `~/Documents/tmp/`. Create the
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
4. For `initial`, open `<chatOrigin>/setup` using the browser procedure below,
   confirm the initial setup page is visible, then report the result. Do not pair.
5. For `paired` and `todolist`, install the checkout's local CLI into the isolated
   stack **before pairing**, even when that version is not published on npm.
   From `<original-cwd>`, substitute the actual `stateDir` and run:

   ```sh
   (
   set -eu
   state_dir='<stateDir>'
   cli_version="$(node -p "require('./third-party/mobius/packages/cli/package.json').version")"
   mkdir "$state_dir/cli-package"
   pnpm --dir third-party/mobius/packages/cli pack --pack-destination "$state_dir/cli-package"
   npm install --prefix "$state_dir/mobius/npm/$cli_version" \
     --ignore-scripts --omit=dev --no-audit --no-fund --save-exact -- \
     "$state_dir/cli-package/moxt-ai-mobius-$cli_version.tgz"
   )
   ```

   Packing runs the CLI's build hook. Stop on a build, pack, or install failure;
   do not fall back to a published CLI that does not contain the checkout's code.
   Do not publish the package or install it globally. This install belongs to the
   disposable stack and is removed with it. Skip it in `initial` mode.

6. For `paired` and `todolist`, launch the selected harness in its own native
   session and ask it to run the following command from `<original-cwd>`.
   Give it the actual state directory, app workspace, and a private output-file
   path under the state directory. Its task is setup and pairing only, not app
   generation or repository changes:

   Launch the harness with its working directory set to `<original-cwd>`, not
   the disposable app workspace. Send this exact prompt after replacing the
   placeholders with the resolved absolute paths and selected harness identifier:

   Save the substituted prompt below as `<private-setup-prompt-file>` under the
   state directory with owner-only permissions. Use the selected harness's full
   command below. These commands bypass its permission prompts and sandbox for
   this bounded local setup task, so inspect the prompt first and never use them
   for unrelated work. An enclosing execution boundary must still authorize the
   operation; these flags do not override that boundary. Check the installed
   harness's help before running; stop if its listed option is unsupported.

   ```sh
   # Codex
   codex exec --cd <original-cwd> --dangerously-bypass-approvals-and-sandbox "$(cat <private-setup-prompt-file>)"

   # Claude Code
   # Run with the command runner's working directory set to <original-cwd>.
   claude --dangerously-skip-permissions -p "$(cat <private-setup-prompt-file>)"

   # Pi
   # Run with the command runner's working directory set to <original-cwd>.
   pi -p "$(cat <private-setup-prompt-file>)"
   ```

   Pi's standard CLI runs tools without a separate approval/sandbox bypass flag;
   do not invent one. Use shell-appropriate quoting for every substituted path.
   Do not use ephemeral sessions: Continue must be able to import this native
   session. Bound the invocation with a timeout that allows setup's five-minute
   readiness deadline, retain its output privately, and stop the owned harness
   process on failure or cancellation. Do not add a restrictive harness sandbox
   that prevents access to the already-running local stack or its process checks.

   ```text
   From <original-cwd>, pair your current <selected-harness> session with Morty.
   Use your own native session ID; do not guess. Run with shell-appropriate quoting:

   node scripts/local-dev.cjs setup --state-dir <stateDir> --harness <selected-harness> --session-id <your-exact-native-session-id> --workspace <app-workspace>

   Save stdout privately to <private-setup-result-file> without overwriting it.
   Wait for completion and leave the Runtime running. Do not open or reveal the
   handoff link. Report only completion or a sanitized error. Do not build an app
   or change repository files.

   Checkout prerequisites and the local CLI installation are already complete.
   Do not run pnpm sync:submodules, git checkout, git switch, or git submodule
   update. Preserve the prepared checkout revision.
   ```

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
   the Chat page. Have the selected harness resolve it inside its own session:
   Codex uses `CODEX_THREAD_ID`, Claude Code uses `CLAUDE_CODE_SESSION_ID`, and
   Pi uses `PI_SESSION_ID`. Use its own session metadata if its variable is
   unavailable; stop if the exact current identifier cannot be resolved. Do not
   ask the user for it, guess, use an unrelated saved session, or substitute the
   verification agent's session. The setup bundle prefers the selected harness's
   environment variable, so the explicit argument must match it.

7. Have the harness capture the setup result to the protected temporary file
   rather than printing it into its response or the conversation. Require private
   filesystem permissions, wait for setup to finish, and read the result privately.
   Ask it to report only completion or sanitized failure, never the handoff URL.
   `handoffUrl` carries a one-time transfer code, so treat it as a secret. Keep
   ownership of the setup harness process and release it on completion, failure,
   or cancellation without stopping the paired Runtime before verification.

This local flow uses Morty's anonymous identity handoff. Clerk sign-in and Clerk
publishable keys are not required; do not restore the obsolete Clerk prerequisites.

Connecting the harness launches it as a Runtime; it does not authorize calling
the harness CLI directly for generation.

## Open Morty in the selected browser

Use browser precedence exactly as resolved above. For an attached browser, use
an explicit tab ID for every operation. For `agent-browser`, load its installed
core skill/help first, create a dedicated named session, launch its first `open`
command with `--headed`, and reuse that same visible foreground session for
every command. Do not run any mode in a headless browser.

In `initial`, open `<chatOrigin>/setup`, confirm the initial setup page, and stop.
Use a fresh browser context without an existing Morty identity; do not clear a
user's existing browser state.

In `paired` and `todolist`, open `handoffUrl` from the setup result; never preview
or redeem it from the setup side. The Continue page redeems the transfer code,
keeps the identity, and opens the native session named by `sessionId` in Morty,
so do not seed storage or use browser internals to manipulate application state
after setup.

In `paired`, confirm the paired Runtime and imported session are visible, then
stop and report the result. The remaining agent-turn verification
sections apply only to `todolist`.

## Ask the agent through Morty (`todolist` only)

Through visible Morty controls:

1. Confirm the agent configuration shows the paired harness; the page serves the
   Bot bound to it, so there is no Bot selector.
2. Select the exact requested model in the Session configuration.
3. Start a new conversation with the **New Session** control.
4. Send an outcome-focused build request that names the already-paired app
   workspace. Ask the agent not to start servers, deploy, or publish, and to
   summarize its work when finished.

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
   active turn visibly accepts it through the conversation's live events.
3. Submit a second follow-up with a harmless, uniquely observable requirement.
   Verify it appears in **Queued messages**, then use its **Delete** action before
   the active turn finishes. Verify the queued entry disappears without being
   submitted as a new user message.

Choose follow-ups that are deterministic and safe to verify. For example, steer
the agent to use a distinctive visible heading, then queue and delete a request
for a second distinctive footer. Do not make timing assumptions: if the initial
turn finishes before all three controls are exercised, the control journey has
failed and must not be reported as verified. Do not slow or alter the Runtime
through internal APIs to keep the turn active.

Wait for the visible turn to complete through live Session events. Confirm in
the UI that the selected model handled the turn and capture the final response
and its summary. Do not infer success merely from files appearing in the
workspace, and do not bypass Morty by querying the daemon or Platform directly.

If generation fails, retain the browser-visible failure and inspect the local
stack logs using `chat-local-full-dev`. Report the failure; do not repair the
app unless the user explicitly requests a repair attempt. Keep initial-failure
evidence distinct from any later repaired result.

## Verification boundary (`todolist` only)

Stop at the completed agent turn in Morty. Check Morty's browser-visible errors
and console failures relevant to the journey. Do not inspect generated files to
grade the result, run generated install/build/start commands, open the generated
app, or test its controls. The to-do requirements and distinctive follow-ups are
task inputs, not acceptance criteria for the generated work. A deficient app is
not an agent-integration failure; a failed agent turn or message control is.

## Retain visual evidence

Screenshot the behavior the user actually asked to verify, at the product
boundary where that behavior is visible. Do not automatically use screenshots
of the generated to-do app as evidence for a Morty, Platform, Runtime, or
streaming fix.

For example, a streaming fix needs screenshots of the Morty conversation while
the turn is still active: one showing partial reasoning and another showing a
partial assistant message before completion. A queue-control fix needs the
relevant queued, steered, or deleted state in Morty. Do not capture generated-app
states for this skill; they do not establish agent-integration behavior.

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

On successful `initial` or `paired` completion, leave the local stack and
dedicated browser open unless the user explicitly requests teardown. Report the
state directory and exact removal command so the user can stop it later.

On failure or cancellation in any mode, clean up owned resources. On successful
`todolist` completion, clean up unless the user explicitly asks to leave services
running:

1. Close the dedicated browser session or tab.
2. Remove the local stack with
   `node scripts/local-dev.cjs remove --state-dir <stateDir>`.

Keep the generated app workspace and repository evidence. Cleanup must never
remove `test-results/`.

## Report the result

Return:

1. Selected mode and browser; for paired modes, the selected harness; for
   `todolist`, the exact model identifier shown in Morty.
2. Local Chat and Platform origins, whether the paired Runtime connected, and
   whether the stack was stopped or intentionally left running. Never report
   identity tokens or handoff links.
3. State directory and removal command when left running; randomized workspace
   path if created.
4. Pass or fail for the requested stopping point: initial setup page for
   `initial`, paired session for `paired`, or the Morty generation turn, queue,
   steer, queued-message deletion, and visible turn completion for `todolist`.
   Mark skipped stages as not run, never passed. Generated-app correctness is
   out of scope, not a passed stage.
5. Repository-relative screenshot paths.
6. Any agent-turn, Worker, Platform, Runtime, local CLI install, or Morty browser
   failure, including relevant typed error codes when available.

Setup-only success is not full journey verification. Do not call the journey
verified unless the task traveled through Morty's local
browser UI and paired Runtime, the visible turn completed with the requested
model, and queue/steer/delete were visibly exercised during the active turn.
