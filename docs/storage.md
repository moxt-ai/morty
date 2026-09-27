# Cloud storage

Morty stores each workspace in a Project Durable Object and uses R2 for the setup
artifact.

- Project Durable Object SQLite stores management and chat records using
  `packages/worker/migrations/project-do`.
- The APAC attachment bucket stores the setup artifact.

Database and R2 binding values are validated at the Worker boundary; missing
bindings fail closed.

## Browser storage ownership

Browser storage is not a Session execution authority. It may contain
credentials, user preferences, and unsent text drafts. Runtime execution and
message delivery state must come from Mobius rather than a browser-local
journal.

| Current browser value | Authoritative owner | Existing support | Required action |
| --- | --- | --- | --- |
| Unsent message text | Browser | Bounded drafts are scoped to a new conversation or existing Session | Remove the draft after submission. Do not put attachment bytes in local storage. |
| Session active-turn marker | Mobius Runtime | `MobiusSessionResources.readSessionExecution` returns the active turn and queue through the Platform and daemon | Do not persist it. Reconstruct working state from Runtime execution snapshots. |
| Unknown-delivery journal | Mobius Runtime | Runtime execution and native history are the observable authority after reload | Keep ambiguous delivery state only for the current page lifetime. Do not persist prompt content, attachments, or retry state. |
| Selected Bot and channel | Browser preference | Morty validates the selected resources when used | Keep the bounded identifiers in browser storage. |
| Last and recent working directories | Browser preference | Runtime validates and resolves directories | Keep the bounded preference, and authorize every selected directory at Runtime. |
| Last Agent settings and new-Session configuration defaults | Browser preference | Mobius exposes the supported catalog and validates Session configuration | Keep bounded preferences and intersect them with the current Mobius catalog before use. |
| Sidebar layout | Browser UI preference | The registered entry is currently unused | If layout persistence is enabled, keep it outside Session-domain state. |
| Anonymous identity, workspace marker, and channel credential | Browser authentication boundary | These credentials let the browser restore identity and prove channel access | Keep them isolated from Session state. |

### Delivery reconciliation

An active-turn snapshot answers whether work is running now. Native history
answers what the Agent retained. If a submission has an ambiguous network
outcome, Morty may offer retry or discard while the page remains open, but it
does not carry that operational state across reloads. After reload, Runtime
execution and native history are authoritative.

### Migration order

1. Persist bounded unsent draft text in the browser; never persist attachment bytes.
2. Remove local active-turn and delivery-journal state and rely on Runtime reconciliation.
3. Leave values written by older clients untouched; current code neither reads nor rewrites them.
4. Keep credentials and bounded preferences isolated from Session execution state.
