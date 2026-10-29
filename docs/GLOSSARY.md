---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Morty contributor glossary

Morty is a browser application built on Mobius. Its code therefore contains both
Morty product concepts and Mobius execution concepts. This glossary names the
boundaries contributors must preserve and explains identifiers that may look
interchangeable but are not.

For the user-facing behavior, start with the [usage guide](GUIDE.md). For the
underlying infrastructure vocabulary, see the
[Mobius glossary](https://github.com/moxt-ai/mobius/blob/main/docs/GLOSSARY.md).

## How the main concepts relate

```text
Project
  ├── User
  └── Bot
       └── Runtime ── represents one paired local execution endpoint
            ├── Agent
            ├── Workspace
            └── Mobius Session ── backs a Morty conversation

Machine
  └── local daemon
       ├── Runtime connection
       └── Agent-owned Native Sessions
                    ├── open/import ── continue the selected history
                    └── fork ───────── create an independent continuation
```

A Bot gives an authorized User a browser entry into a paired Runtime. A Runtime can
serve many Sessions and can advertise more than one Agent. A Native Session belongs
to an Agent, not to Morty. Morty can ask Mobius to open or fork one, but that does not
make the Native Session and the Mobius Session the same resource.

## Morty application concepts

### Project

The authorization and isolation boundary for a Morty installation. Users, Bots,
Runtimes, conversations, and sharing credentials are scoped through a Project. In
code, a Project ID must not be treated as a machine, Bot, Runtime, or Session ID.

Morty uses Mobius Projects underneath, but the contributor-facing rule is the same:
cross-Project access is a boundary crossing and must be explicitly authorized.

### User

The Morty identity authorized to use Bots and conversations in a Project. A User is
not the operating-system account running the daemon and is not an Agent identity.
Anonymous and account-bound browser flows can still resolve to a Morty User.

### Bot

The browser-facing resource through which a User reaches a configured local
environment. A Bot resolves the Runtime available to the chat experience and lets a
conversation select an advertised Agent and workspace.

A Bot is not an Agent process, Runtime, machine, or conversation. One Bot can expose
many conversations over the same Runtime.

### Conversation

The user-facing chat Morty opens in the browser. A conversation presents messages,
tool activity, interactions, files, and controls around a Mobius Session.

In the common path, one open Morty conversation is backed by one active Mobius
Session. Contributors should still avoid using `conversationId`, `sessionId`, and a
Native Session ID interchangeably: they describe different boundaries even when a
particular flow assigns equal string values.

### Managed Session

A Mobius Session that Morty has registered for a User and Bot so it can appear in
the conversation directory and be reopened. The managed record is ownership and
discovery metadata; it does not mean Morty stores a complete copy of the Agent's
history.

Archiving a Managed Session removes it from Morty's managed conversation list. It
must not be assumed to delete the Agent's Native Session or local history.

### Machine

The computer, VM, container, or WSL environment where the daemon and Agents run.
Morty stores a local machine identity during setup, but a Machine is not the same as
its cloud Runtime. Replacing a Project or pairing can replace the Runtime while the
physical machine remains the same.

### Local daemon

The Mobius service running on the Machine. It maintains the Runtime connection,
discovers Agents, starts or restores Agent work, and enforces the local filesystem
and execution boundary. Morty's Worker and browser do not execute the coding Agent.

### Runtime

The Project-scoped Mobius execution endpoint created by pairing the local daemon.
Morty routes Agent discovery, workspace browsing, Session operations, and live
events through it. One Runtime connection carries many Sessions; a Runtime is not
created per conversation.

### Agent

A coding Agent available through the Runtime, such as Codex, Claude Code, or Pi.
The selected Agent determines which native-history, fork, interaction, and content
capabilities exist. Morty must not present a capability merely because another
Agent supports it.

### Workspace and directory

The local filesystem context authorized for Agent work. The browser works with
opaque directory identities supplied by the Runtime, not arbitrary client-provided
paths. Additional directories extend a Session's authorized context without
creating a new Runtime.

## Session and history concepts

### Mobius Session

The live conversation and execution scope hosted by one Runtime. It selects an
Agent and workspace context, receives turns and control operations, and publishes
events to Morty. This is the Session Morty's browser connects to and the Session
stored in the managed conversation directory.

A new Morty conversation creates a Mobius Session. Opening existing Agent history
also results in a Mobius Session through which Morty continues the work.

### Native Session

A conversation record owned and persisted by the underlying Agent. Examples include
a Codex thread or a Claude Code conversation saved on the Machine. It can exist
before Morty is installed and can remain after Morty stops.

Native Sessions are discovered through the selected Agent's capabilities. Their
availability, identity, history completeness, and ability to resume or fork remain
authoritative at the Agent boundary.

“Non-native Session” is not a separate protocol type. In contributor discussions,
the intended contrast is usually a **Mobius Session** created or managed by Morty
versus a **Native Session** owned by the Agent.

### Native Session entry

A discovery result representing one Agent-owned conversation in a particular
workspace. Its entry ID is an opaque handle for the current discovery operation;
it is not necessarily the Native Session ID or a Mobius Session ID. Refreshing the
directory can produce a new discovery context, so stale entries must not authorize
later operations.

### Open / import

Continue the selected Native Session through Morty without intentionally cloning
its history. The Runtime asks the Agent adapter to load or resume that native
conversation and exposes the resulting live work through a Mobius Session.

The code and protocol use `import` for this operation while the UI says **Open**.
Import here means “attach this Agent-owned conversation to Morty's managed flow,”
not “upload and permanently copy its entire history into Morty.” Once opened, the
resident Agent state is authoritative for that Morty Session; alternating writers
between Morty and the native client can diverge or be refused.

### Fork

Create an independent continuation from a selected Native Session when the Agent
supports native forking. The fork receives a new target Session identity while
preserving the source context available to the Agent. Further messages in the fork
must not be assumed to update the source Native Session.

Fork is a capability, not a fallback implementation for import. If the Agent cannot
fork reliably, Morty must report that limitation rather than simulate success.

### Session entry ID, Mobius Session ID, and Native Session ID

- A **Session entry ID** selects an item returned by native-session discovery.
- A **Mobius Session ID** addresses live and managed Session operations through the
  Runtime and Relay.
- A **Native Session ID** identifies the Agent-owned conversation.

Some creation paths deliberately reuse a value across layers. That is an
implementation choice, not permission to collapse the concepts or skip validation
at a boundary.

### History

Morty can present history from the live Session, the Agent's Native Session, or an
optional Mobius Recording. These sources have different ownership and recovery
guarantees. Morty production keeps cloud Recording disabled, so a managed record in
the sidebar is not proof that full history is available while the Machine is
offline.

### Turn, queue, and interaction

A Turn is a unit of user input submitted to a Mobius Session. Morty can queue a
follow-up while another Turn is active. An interaction is a decision requested by
the Agent during execution, such as a permission or elicitation request; it is not a
new conversation or Session.

## Access and connection concepts

### Setup and pairing

Setup creates or reuses Morty's local identity and establishes the Mobius pairing
needed for a Runtime. Pairing authorizes a local daemon for a Project and stores its
Runtime connection locally. Reconnecting an existing Runtime is not a new pairing.

### Sharing link and browser identity

A Morty link carries the information needed to establish an authorized browser
identity for a Project or conversation flow. It is not the daemon's Runtime
credential. Revoking shared access must not be modeled as deleting the Machine's
Agent history.

### Session access

The short-lived credential and endpoint information that let a browser connect to
one Mobius Session. Session access does not make the browser a Runtime and does not
grant access to every Session on the Machine.

### Relay

The trusted Mobius cloud service that authenticates and routes traffic between
Morty and the local Runtime. It carries live traffic but does not turn Morty's
managed metadata into a complete cloud copy of Native Session history.
