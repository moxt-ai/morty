# Morty

Morty connects a browser chat workspace to local Agents through Mobius.

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
