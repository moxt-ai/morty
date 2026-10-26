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

[Mobius](https://github.com/moxt-ai/mobius) provides remote access to local
Agents. Morty supplies Bots, conversation access and the browser experience, so users
can focus on their work without building a client themselves. Available operations
depend on the Agent and configuration, and unavailable capabilities or history must
be clear to the user.

## Data ownership and recovery

Live output favors responsiveness over guaranteed delivery. Disconnects and restarts
can leave gaps; catch-up depends on the current turn, native Agent history or available
cloud recordings. Optional Recording must not slow the conversation and is not a
lossless archive. See Mobius's [data ownership and recovery](https://github.com/moxt-ai/mobius/blob/main/docs/GUIDE.md#data-ownership-and-recovery)
for where retained data lives.

For hosting and runtime configuration, see [deployment](deployment.md).
