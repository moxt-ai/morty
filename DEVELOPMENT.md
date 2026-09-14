# Development

## Product boundary

Anonymous credentials and Clerk sessions resolve to a canonical internal user ID.
Clerk verifies a user session only. The application does not read Clerk Organization
claims. Platform Project setup uses the server-held AppCredential; the Worker
supplies a logical location hint and Platform resolves its storage placement. Bots and
Chat support anonymous users; Slack additionally requires a verified Clerk session.
Chat derives new Project placement from Cloudflare's server-provided `request.cf.continent`:
Asia/Oceania use `apac`; other recognized continents use `wnam`, the other supported region.
Missing or unrecognized metadata falls back to `MOBIUS_PROJECT_LOCATION_HINT`.
Client headers and request bodies do not control this selection. Existing Projects retain
their recorded placement when the user changes location.

First-time visitors to `/` receive a browser-held anonymous identity and personal
Bot; returning visitors restore their saved identity automatically. Every web
workspace copies `/pair.md?token=...`, a one-time ticket that connects the local
Runtime to its current user and Bot and directs the user back to Chat.
`/setup.md` is reserved for standalone testing and external sharing, including
social posts. That flow creates or reuses a local identity and returns a browser handoff.
The active web flow has no Project setup or Slack navigation. The web application
sends its anonymous credential or Clerk bearer token to Chat for ownership checks
and conversation access. Platform independently authorizes SDK operations.

## Worker structure

Feature logic stays below `packages/worker/src/components`:

- `cloud`: Clerk configuration, token verification, and `/mobius-cloud/api`.
- `chat`: safe forwarding for `/mobius/api/*`.
- `slack`: Slack HTTP routes, services, queue processing, D1/R2 adapters, and rate limiting.

All external gateways and top-level request dispatch stay directly under
`packages/worker/src/gateway`; components do not contain gateway directories.

Slack is source code in the Worker package, not an embedded package or standalone
deployment. Shared runtime helpers remain directly under `packages/worker/src/infra`.

## Storage

Every environment binds regional D1 databases as `CHAT_DATABASE_APAC` and
`CHAT_DATABASE_WNAM`, with corresponding `CHAT_ATTACHMENTS_APAC` and
`CHAT_ATTACHMENTS_WNAM` R2 buckets. Chat resolves the caller-supplied Project through
Platform's public storage-placement endpoint and verifies ownership separately.
The browser persists `{ userId, projectId }` and supplies `X-Mobius-Project-Id`.
Only one-time pairing and transfer tickets embed Project context; anonymous
credentials are opaque. Apply the schema locally with:

```sh
pnpm exec wrangler d1 migrations apply CHAT_DATABASE_APAC --local
pnpm exec wrangler d1 migrations apply CHAT_DATABASE_WNAM --local
```

Staging and production resources are named in `wrangler.jsonc`. Apply remote
migrations with the matching Wrangler environment.

Slack management requests also supply `X-Mobius-Project-Id`. Generated Slack
event and OAuth callback URLs, and attachment links, carry a `projectId` query
parameter. Queue deliveries contain `{ projectId, message }` so asynchronous
processing resolves the same regional bindings. Callback routing does not replace
Slack signature or OAuth-state validation.

Clerk binding returns only the Chat user ID. Discarding a conflicting local
workspace opens transfer-link recovery; it cannot discover the other Project.

## External Mobius

`MOBIUS_BASE_URL` must be an HTTP loopback origin for local development or an HTTPS
origin elsewhere. It cannot contain credentials, a path, query, fragment, or Cloud's
own origin. `MOBIUS_APP_ID` and `MOBIUS_APP_SECRET` authenticate Worker operations.
The active Chat API issues short-lived conversation credentials after checking Bot
ownership. The browser uses `createMobiusConversationSession` to communicate directly
with Mobius, including history, messages, events, and credential refresh.
The Worker discovers/imports native sessions through the Project SDK. Its
`session-access` endpoint issues credentials scoped to the selected Session inside
the user's Project. The browser uses those credentials with the Session SDK to
communicate directly with Mobius; it receives no Runtime-wide host credential.
Slack's `MobiusGateway` also calls Mobius
directly and rejects recursive configuration and redirects.

## Verification

Run `pnpm check`. Product behavior is covered at HTTP and browser boundaries; tests
use deterministic time and stateful fakes rather than request mocks.

Run `pnpm test:e2e:opencode` for the opt-in live system check. It creates isolated
temporary state, starts the submodule's local mobius-platform and Mobius daemon plus
the local mobius-chat Worker, selects a currently advertised free OpenCode model,
sends a unique message through a headless Chrome session, and verifies the rendered
OpenCode response.
