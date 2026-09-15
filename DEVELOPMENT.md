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
Both instruction documents are Markdown templates in `templates/`, outside the
static public assets. The Worker renders them at `/setup.md` and `/pair.md` at
request time. `{{BASE_URL}}` uses `APP_ORIGIN` when set, otherwise the
request URL's origin (including the port for local development). Set `APP_ORIGIN`
to a canonical HTTP(S) origin without a trailing slash, path, credentials, query,
or fragment. Invalid configuration returns `INVALID_INSTRUCTION_ORIGIN` rather
than instructions. The Worker stores rendered documents in Cloudflare's edge cache
for five minutes (`Cache-Control: public, max-age=0, s-maxage=300`). Cache keys include
the request origin, document path, and resolved Chat origin, but exclude ticket tokens
and other request query parameters. `X-Instruction-Cache` reports `HIT` or `MISS`.
The active web flow has no Project setup or Slack navigation. The web application
sends its anonymous credential or Clerk bearer token to Chat for ownership checks
and conversation access. Platform independently authorizes SDK operations.

## Worker structure

### Project-ID regional routing

After this, a user can reload a Project workspace through the same Chat origin
and have its request authenticated by the corresponding regional Chat Worker.
The public Worker routes Project-scoped requests using the validated Project ID;
pairing/transfer redemption uses the Project encoded in its existing ticket.
Anonymous creation chooses a region from Cloudflare request metadata, with the
configured location hint as fallback. Client-provided region headers have no
authority. Regional backends still authenticate the user and check ownership.

Regional backends decode Project placement locally rather than calling Platform's
storage-placement endpoint. They call Platform's public API, whose own router
selects the regional Platform backend. A mismatched Project sent directly to a
Chat backend returns HTTP 421. Requests without Project context otherwise retain
their existing entrypoint, as do queue consumers.

`regional-placement.json` controls explicit placement hints for each backend.
The public Worker has placement disabled; regional Workers use service-binding
`fetch()` and explicit cloud-region hints. Hints are not exact-city guarantees.
Existing D1/R2 resources, queue producers, and the public Worker's Durable Object
namespace are shared. Regional Workers do not own queue consumers.

Each product owns a small `wrangler.regional.template.json` containing only
regional overrides: Worker name, entrypoint, placement hint, logical region, and
deployment flags. Shared D1/R2/KV bindings, compatibility settings, variables,
and other common settings are inherited from the existing configuration.
The renderer JSON-encodes `<%% name %%>` substitutions and rejects missing or
unresolved placeholders before writing valid JSON. Deployment renders configurations from the Vite-built Worker using
`third-party/mobius/packages/relay-cloudflare-platform/scripts/regional-workers.ts`.
Both regional backends deploy before the public router. Before the first regional
deployment, provision the same required runtime secrets on
`mobius-chat-<environment>-apac` and `mobius-chat-<environment>-wnam` as on the
public Worker. Secret values are not readable or automatically copied from the
public Worker; CI verifies all three secret-name inventories before deploying.

To generate configs for inspection after `pnpm build:staging`:

```bash
node third-party/mobius/packages/relay-cloudflare-platform/scripts/regional-workers.ts \
  --config wrangler.jsonc --built --env staging \
  --template wrangler.regional.template.json \
  --placement regional-placement.json --output .wrangler/regional/staging
pnpm exec wrangler deploy --config .wrangler/regional/staging/apac.json --dry-run
pnpm exec wrangler deploy --config .wrangler/regional/staging/wnam.json --dry-run
```

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
Platform's public storage-placement endpoint, which returns only `{ location: string }`,
and verifies ownership separately. Chat accepts `apac` or `wnam` and selects its own
regional database and attachment bucket from that location.
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
New Conversation opens a browser-local draft. Its Harness selector chooses a paired
agent; a temporary Project Session prepares that agent's model options and is deleted
after preparation. First Send creates a canonical Project Conversation with the selected
model and approved Bot binding. Existing conversations reopen by Conversation ID,
including credential refresh, and keep their harness fixed.
First Send keeps the created connection and transitions the draft in place; it
updates the saved URL without removing the sidebar or composer to reconnect.
The Worker discovers/imports native sessions through the Project SDK. Its
`session-access` endpoint issues credentials scoped to the selected Session inside
the user's Project. The browser uses those credentials with the Session SDK to
communicate directly with Mobius; it receives no Runtime-wide host credential.
Slack's `MobiusGateway` also calls Mobius
directly and rejects recursive configuration and redirects.

## Verification

Run `pnpm check`. Product behavior is covered at HTTP and browser boundaries; tests
use deterministic time and stateful fakes rather than request mocks.
