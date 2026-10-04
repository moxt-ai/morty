# Morty (Mobius Chat)

## Why Morty exists

An Agent may be working on your computer while you are somewhere else. You need a
convenient place to check its progress, answer a question, give the next instruction
and see the result without returning to the terminal where the work started.

Morty makes that a browser chat experience. Bots give users a recognizable way to
return to their work, and conversations keep instructions, progress and results
together. Users should be able to focus on the task rather than arrange their own
remote Agent client.

## Functional value

| User need | What Morty should make possible |
| --- | --- |
| Know where to send work | Set up and select a Bot connected to the machine and Agent intended for the task. |
| Direct the work through chat | Send instructions, queue follow-ups, stop work and respond when the Agent needs input. |
| Understand what happened | See progress, replies, available history and generated images or files in the conversation. |
| Continue from another browser | Return to the same conversation, see instructions sent elsewhere and continue participating. |
| Keep conversations accessible to the right users | Access Bots and conversations only with the appropriate permission. |

These goals guide the product; the selected Agent and configuration determine which
operations are available. Missing capabilities and unavailable history must be clear
rather than appearing to succeed or silently disappearing.

## Non-functional value: speed

- **Open and continue quickly:** useful recent messages should appear promptly even
  in a long conversation; older messages can be requested when needed.
- **See progress immediately:** display incoming output promptly while keeping typing,
  sending and stopping responsive.
- **Get back in quickly:** after reopening the page or reconnecting, users should
  quickly understand the latest progress and whether they can continue.

## Relationship to Mobius

Morty is the chat product people use. [Mobius](third-party/mobius/README.md) makes
their local Agents accessible remotely and provides the operations Morty presents.
Morty supplies Bots, conversation access and the browser experience, so users do not
have to build an application on the Mobius SDK themselves.

History availability and restart limitations follow the selected Mobius setup; see
[data ownership and recovery](third-party/mobius/README.md#data-ownership-and-recovery).

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

- [Development](DEVELOPMENT.md): implementation entrypoints and build operations.
- [Testing](TESTING.md): test commands and composition entrypoints.
- [Engineering rules](AGENTS.md): contribution requirements.
- [Mobius](third-party/mobius/README.md): CLI, SDK and hosting usage.
