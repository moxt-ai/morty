---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Using Morty

This guide covers connecting your coding Agent, continuing conversations from a
browser, and understanding history and recovery. For the product overview, see the
[README](../README.md). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Get connected

Open [morty.build](https://morty.build) and copy the setup prompt into the coding
Agent on your computer. Open the link it returns, or scan its QR code on your phone.
Keep the connected machine awake and online; the Agent runs in that environment.

## Conversations across screens

An Agent may be working on your computer while you are somewhere else. You need a
convenient place to check its progress, answer a question, give the next instruction
and see the result without returning to the terminal where the work started.

Morty makes that a browser chat experience. A Bot connects you to the machine and
Agent intended for the task. In its conversations, you can send instructions, queue
follow-ups, stop work, respond to permission requests and view available history,
files and generated images. Access to Bots and conversations belongs to the users
authorized to use them.

You should be able to open the same conversation in another browser, catch up on
instructions sent elsewhere and continue participating. New output should appear
promptly even during a long answer. Displaying each update should process the new or
changed content without repeatedly rebuilding the entire turn; opening or reconnecting
may require a separate catch-up step.

Morty includes the local Runtime, relay, and browser experience. Available operations
depend on the Agent and configuration; unavailable capabilities or history must be
clear to the user. Morty and Moxt may discover the same installed Agent, but must not
write to the same Agent conversation concurrently. Stop or release the current
writer before continuing it elsewhere.

## Data ownership and recovery

Live output favors responsiveness over guaranteed delivery. Disconnects and restarts
can leave gaps; catch-up depends on native Agent history. Morty keeps no cloud
copy of conversation history. Agent-owned history stays in the Agent's directories;
Morty uninstall must never remove it.

Morty's state directory is `~/Library/Application Support/Morty/v2` on macOS,
`%LOCALAPPDATA%\Morty\v2` on Windows, and `$XDG_STATE_HOME/morty/v2` (or
`~/.local/state/morty/v2`) on Linux. An absolute `MORTY_STATE_DIRECTORY` overrides
it. Use a fresh empty directory; existing unmarked data and earlier installation
generations are not adopted. This pre-launch reset requires new installation
and pairing; earlier Morty clients, credentials and browser state are unsupported.

The `@morty-build/cli` npm command is a launcher for the persistent installed
release. Use `npx --yes @morty-build/cli` followed by `status`, `doctor`, `stop`,
`start`, `restart`, `update`, or `uninstall`. `restart` does not download a version;
`update` verifies a candidate before switching and attempts to restore the previous
release if activation fails. `doctor` reports the last installation operation.
After an interrupted update, inspect `doctor` and restart the selected release;
reinstall a known-good exact version if its files are incomplete.

For hosting and runtime configuration, see [deployment](deployment.md).
