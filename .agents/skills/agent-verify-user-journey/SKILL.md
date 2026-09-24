---
name: agent-verify-user-journey
description: Have a selected agent harness and model build a disposable to-do web app, then verify its user journey with a selected browser and retain screenshots. Use when a user asks to test an agent's ability to create and exercise a web app, especially prompts such as "use Codex, GPT 5.5, and agent-browser CLI to verify a todo app."
---

# Agent User-Journey Verification

Ask an agent to build a small web application in an isolated scratch directory,
then verify the result as a user through a real browser. Keep the generated app
out of the current repository and keep verification screenshots in the current
repository's `test-results/` directory.

## Resolve the request

Resolve these inputs before starting:

| Input | Default | Selection rule |
| --- | --- | --- |
| Harness | `codex` | Use the harness the user names; otherwise use `codex`. |
| Model | `gpt 5.6 terra` | Use the model the user names; otherwise use `gpt 5.6 terra`. |
| Browser | session-attached browser, then `agent-browser` CLI | Honor a user-specified browser first. Otherwise use the browser attached to the current session when one exists; fall back to an installed `agent-browser` CLI. |
| App | to-do-list web app | Preserve any app or journey requirements supplied by the user. |

Treat names in example requests as parameters, not fixed requirements. For
example, replace `codex` with the selected harness and `gpt 5.5` with the
selected model.

Do not silently substitute a different harness, model, or explicitly requested
browser. Check that each selected tool is available. When a display name needs
an exact model identifier, use the harness's model catalog or help output to
resolve it. If resolution is ambiguous, ask the user rather than guessing.

## Prepare isolated paths

Resolve the directory from which the user invoked the skill and retain it as
`<original-cwd>`. Create both locations without overwriting existing content:

- App workspace: a randomized directory under `~/tmp/`, such as one created by
  `mktemp -d "$HOME/tmp/agent-verify-user-journey.XXXXXX"` after ensuring
  `~/tmp` exists.
- Evidence: `<original-cwd>/test-results/agent-verify-user-journey/<run-name>/`.

Use a short, filesystem-safe run name. Never initialize or modify the app inside
the current repository. Do not include credentials, user data, or private
configuration in the app or screenshots.

## Have the selected agent build the app

Run the selected harness with the selected model and set its working directory
to the randomized app workspace. Use the harness's installed CLI and documented
non-interactive invocation; inspect its local help when necessary instead of
guessing flags.

Give the coding agent an outcome-focused prompt. Unless the user supplied more
specific requirements, require a locally runnable to-do web app in which a user
can:

1. See an empty state.
2. Add a named item.
3. Mark the item complete and see its completed state.
4. Delete the item and return to the empty state.

Also ask the agent to provide the exact install and start commands. Let the
selected agent author the application; do not prebuild the implementation for
it or hide failures by repairing the app before recording the first result.
Capture the harness's exit status and concise output needed to explain what it
created. Never expose provider credentials or copy them into the scratch app.

## Start and inspect the app

Inspect the generated files and follow the agent-provided commands only after
checking that they are local development commands. Do not run deployment,
publishing, credential-reading, privilege-escalation, or unrelated filesystem
commands. Bind the development server to loopback and use its reported URL;
do not assume a fixed port. Keep ownership of the server process and stop it on
success, failure, or cancellation.

If the app cannot install, build, or start, report the failure as the
verification result. Do not change source code unless the user explicitly asks
for a repair attempt; if they do, keep the initial failure evidence distinct
from the repaired result.

## Choose and drive the browser

Use browser precedence exactly as resolved above:

1. The browser explicitly requested by the user.
2. A browser attached to the current session, when browser tools are available.
3. The installed `agent-browser` CLI.

For an attached browser, open or reuse an explicit tab and use only that tab's
identifier for subsequent operations. For `agent-browser`, inspect its local
help and use its supported commands rather than assuming a version-specific
interface. If no eligible browser is available, stop and report the missing
capability; do not claim the journey passed from source inspection alone.

Exercise the application through visible controls, labels, and text as a user
would. Do not call application internals, mutate storage directly, or treat a
successful page load as proof of the full journey. Verify every requested state
and record any browser-visible error or console failure relevant to the journey.

## Retain visual evidence

Capture multiple screenshots when they make different journey states clear.
Use ordered, descriptive PNG names under the evidence directory, for example:

```text
test-results/agent-verify-user-journey/<run-name>/
  01-empty.png
  02-item-added.png
  03-item-completed.png
  04-item-deleted.png
```

Capture screenshots only after reaching the corresponding state through normal
browser interactions. Keep the evidence after stopping the server. Do not place
screenshots in the randomized app directory.

## Report the result

Return:

1. Selected harness, exact model identifier, and browser.
2. Randomized app workspace path and the commands used to run it.
3. Pass or fail for each user-visible journey step.
4. Repository-relative paths to retained screenshots.
5. Any agent-generation, install, server, browser, or application failure.

Do not call the journey verified unless the selected browser completed every
required interaction and observed the expected visible result.
