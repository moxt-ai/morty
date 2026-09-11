# Chat completion verification

After this, a user can send a message to a connected local agent and see its
reply without reloading, then reopen Chat and see the retained reply.

## Acceptance scenario

**Given** an open Chat conversation with a connected local Runtime,
**when** the user sends a message and the agent completes it,
**then** the reply appears in that page without a reload and remains after reload.

Before the fix, the staging browser showed an empty response for a completed
`hello`, while the conversation history API returned `succeeded` and a
434-character reply. This failed the no-reload assertion.

History updates now reject older committed sequences and use the current React
state. The SDK event stream drives live updates; a cancellable, non-overlapping
five-second history reconciliation loop also recovers missed updates. Refresh or
stream failures offer reconnection rather than silently leaving stale history.
Empty replies show the actual attempt status, including waiting, failure,
cancellation, and completion without text.

The first live retry revealed another failure: a reply appeared alongside a
duplicate thinking row. Both the expired older turn and the running new turn had
an empty `messageId`, creating duplicate React keys. The new turn later acquired
a response message ID. Rows now use the stable, distinct `commandId` instead.

## Manual procedure

1. Open staging Chat using the saved setup identity and start its paired Runtime.
2. Send a fresh message through the message form.
3. Confirm an agent response appears without navigation or reload, with exactly
   one row per submitted message and no leftover thinking row for completed turns.
4. Reload and confirm the same message and response are retained.

Use the browser CLI for this manual procedure. Do not save credentials or
one-time handoff links in verification output.

## Verified result

On staging with the published Mobius CLI 0.0.28, a fresh greeting returned
`Chat is working — hello again! 👋` without a reload. The page contained exactly
three submitted messages, two successful replies, and the earlier expired `HI`.
There were no leftover thinking rows or page alerts. Reload preserved both
successful replies and the same three messages.

The saved setup had been running CLI 0.0.27. Its old `HI` had no attempt until
the fixed Runtime received it, then failed with `turn_expired`. The installed
CLI was upgraded to 0.0.28 and its paired Runtime restarted before the final
fresh-message check. Existing Runtime diagnostics were sufficient; no temporary
server logging was added.

`pnpm check` passed, and the fixed Chat was deployed to staging.
