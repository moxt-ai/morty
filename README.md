# Morty

Morty connects a browser chat workspace to local Agents through Mobius.

## Product boundary

Morty owns Bots, conversation membership, user access and the chat experience.
Mobius connects authorized clients to local Agent execution and available history.
Morty should use that authority rather than infer independent execution outcomes
from browser-local state. A browser disconnect must not itself cancel an Agent's
work; opening the same conversation elsewhere must allow recovery of its accepted
prompts and available output.

The cross-service requirements for authorization, synchronization, current-turn
recovery and persistence are defined in the [Mobius product contract](third-party/mobius/README.md#product-responsibilities).
The [storage disclosure](third-party/mobius/README.md#data-ownership-and-recovery)
describes current persistence and restart limitations. Morty must not promise durable
execution or history beyond those capabilities.

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
