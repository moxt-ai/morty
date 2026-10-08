---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Morty

## Why Morty exists

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

[Mobius](third-party/mobius/README.md#why-mobius-exists) provides remote access to local
Agents. Morty supplies Bots, conversation access and the browser experience, so users
can focus on their work without building a client themselves. Available operations
depend on the Agent and configuration, and unavailable capabilities or history must
be clear to the user.

Live output favors responsiveness over guaranteed delivery. Disconnects and restarts
can leave gaps; catch-up depends on the current turn, native Agent history or available
cloud recordings. Optional Recording must not slow the conversation and is not a
lossless archive. See Mobius's [data ownership and recovery](third-party/mobius/README.md#data-ownership-and-recovery)
for where retained data lives.

## Start here

```sh
pnpm install
pnpm sync:submodules
pnpm local-dev --help
```

Use the isolated local-stack instructions in
[chat-local-full-dev](.agents/skills/chat-local-full-dev/SKILL.md).
Runtime configuration is described in [deployment](docs/deployment.md).
Node and pnpm versions are pinned in [package.json](package.json).

- [Development](DEVELOPMENT.md): development constraints and build operations.
- [Testing](TESTING.md): test commands and dependency boundaries.
- [Engineering rules](AGENTS.md): contribution requirements.
- [Mobius](third-party/mobius/README.md): CLI, SDK and hosting usage.
