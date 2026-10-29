<div align="center">

# Morty

**English** · [简体中文](README.zh-CN.md)

### Step away from your desk. Keep work moving.

Continue Codex, Claude Code, and Pi conversations from any browser.

[Open Morty →](https://morty.build) · [Get connected](#one-prompt-then-pick-up-your-phone) · [Contribute](docs/CONTRIBUTING.md)

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Built on Mobius](https://img.shields.io/badge/built_on-Mobius-111.svg)](https://github.com/moxt-ai/mobius)

<img src="docs/assets/readme-accent.svg" width="320" height="40" alt="" />

</div>

Your agent is working on your computer. Morty puts the conversation on your phone,
tablet, or another screen, so you can check in and give the next instruction wherever
you are.

## Stay in the loop

- **See work as it happens.** Follow live replies and tool activity, then open files
  and generated images from the conversation.
- **Keep things moving.** Send instructions, queue follow-ups, stop a turn, or answer
  supported approval requests.
- **Switch screens, keep the context.** Return to your connected conversations from
  another browser and pick up where you left off.

## Your agent. Your setup.

Your projects, tools, and signed-in agent stay on the connected machine. Morty gives
you a browser view into that environment. Open your connected conversation from
another screen. Share access when you want someone else to join, and revoke it
when you're done.

## One prompt. Then pick up your phone.

Open [morty.build](https://morty.build) and copy the setup prompt, or paste this
into your coding agent:

```text
Fetch https://morty.build/setup.md and set up Morty for me.
You may install missing prerequisites and pair this machine.
Complete setup without asking questions.
```

Open the link it returns, or scan the QR code on your phone. No mobile app required.

Setup is a document your agent reads, not a black box:
[setup.md](https://morty.build/setup.md) is public, and it tells your agent to
download the installer to a private temporary directory and inspect it before
running it. Read it yourself before you paste the prompt.

## What you need

- One of **Codex**, **Claude Code**, or **Pi**, installed and signed in on your computer
- **Node.js 22.19.0 or newer**
- The connected machine **awake and online**. Morty is a window into a session running
  on your computer, not a cloud sandbox. When the computer sleeps, the session pauses
  with it.

## What Morty does with your data

- **Your conversation is read live from your machine.** The browser keeps a session
  ID and title; the history itself is fetched from the daemon on your computer each
  time you open a session. When that computer is offline, the history is not
  available in the browser. That is the design, not a cache miss.
- **Cloud Recording is off.** Mobius supports optional cloud Recording for
  applications that want history to survive a machine going offline. Morty does not
  enable it; the application policy sets Recording to `disabled`, and no Morty
  project overrides it.
- **The relay carries traffic; it is not a vault.** Session traffic reaches your
  machine through the Mobius relay. **Morty is not end-to-end encrypted** — the
  relay is a trusted component in this design. If end-to-end encryption is a
  requirement for you, Morty does not meet it today.
- **Your machine's identity stays on your machine.** Setup stores this computer's
  Morty identity in your user's local application data directory, protected by
  filesystem permissions. It is not synced between computers, and each computer has
  its own.
- **Sharing is explicit, and revocable.** A sharing link grants whoever holds it the
  ability to view and control sessions in that project. To withdraw every link
  previously shared from a machine, tell your agent:
  *"Revoke all links I previously shared from this machine."*

## Leaving

Morty does not hold your session hostage. Run `mobius quit` and every Morty session
on that computer closes while pairing and the agent's own history stay intact. Pick
the conversation back up natively:

| Agent | Resume |
| --- | --- |
| Codex | `codex resume` |
| Claude Code | `claude --resume`, or `claude --continue` for the most recent one |
| Pi | `pi --resume`, or `pi --continue` for the most recent one |

`mobius start` reconnects Morty later.

## Security

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).
Don't open a public issue for a security problem.

---

Built on [**Mobius**](https://github.com/moxt-ai/mobius), the SDK and infrastructure
for remote coding-agent access. Morty is the ready-to-use browser application.

[Contributing](docs/CONTRIBUTING.md) · [Testing](docs/TESTING.md) · [Usage guide](docs/GUIDE.md) · [Deployment](docs/deployment.md) · [Security](SECURITY.md)

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

"Morty" and "Moxt", and the Morty and Moxt logos, are trademarks of Moxt. The
Apache 2.0 license grants you rights to the code, not to the names or marks — a
fork is welcome, but please give it a name of its own.
