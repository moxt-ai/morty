# Development

## Product boundary

Anonymous credentials and Clerk sessions resolve to a canonical internal user ID.
Clerk verifies a user session only. The application does not read Clerk Organization
claims. Platform Project setup uses the server-held AppCredential; the Worker
supplies a logical location hint and Platform resolves its storage placement. Bots and
Chat support anonymous users; Slack additionally requires a verified Clerk session.
Chat derives new Project placement from Cloudflare's server-provided `request.cf.continent`:
Asia/Oceania use `apac`; other recognized continents use `wnam`, the other supported region.
Missing or unrecognized metadata falls back to `apac`, defined in code.
Client headers and request bodies do not control this selection. Existing Projects retain
their recorded placement when the user changes location.

First-time visitors to `/` receive a browser-held anonymous identity and personal
Bot; returning visitors restore their saved identity and last selected Bot
automatically. The Bot menu can create another Bot for another machine and can
remove a Bot while at least one other Bot remains. Every web workspace copies
`/pair.md?token=...`, a one-time ticket that connects the local Runtime to its
current user and Bot and directs the user back to Chat. A Bot's Runtime ID is fixed
after its first binding. Pairing reconnects saved Runtime state only after the
ticket proves the same Chat origin, user, Project, and Bot, names that Runtime as
its expected target, and Platform confirms the Runtime pairing is still active.
An unbound Bot can create a fresh Runtime identity; pairing another machine
requires another Bot.
`/setup.md` is reserved for standalone testing and external sharing, including
social posts. That flow requires the current harness session ID, creates or reuses a
local identity, reconnects its matching active Runtime or creates a fresh one, and
returns a browser handoff carrying the validated harness and native
session ID. The ready result includes the exact URL, its expiry, an owner-only PNG QR
code, and the path to a private temporary text file containing a terminal-safe QR
rendering. The bundled setup CLI decodes the PNG before returning it so the QR payload
cannot differ from the URL. The browser handoff shows the native session's harness and ID,
then requires the user to import the original, fork an independent continuation, or skip it.
The selected import or fork crosses the Chat boundary explicitly; an import failure never
falls back to a fork without another user choice. Native
session IDs are not returned by ordinary directory listings. The redeemed browser credential
remains bound to that transfer's 24-hour lifetime. A user can choose **End remote access**
from the continued Session; this revokes the entry and every browser credential redeemed from
it without stopping the local Runtime or task.
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

### Web asset CDN

Staging and production builds load content-addressed JavaScript and CSS from an
append-only R2 bucket. Deployments upload the new assets before activating the
new Worker, so an already-open page can continue loading its original chunks
after later deployments. Do not delete objects from these buckets.

Provision the buckets and their custom domains once, replacing each zone ID
with the Cloudflare zone that owns the domain:

```sh
pnpm exec wrangler r2 bucket create morty-staging-web-assets
pnpm exec wrangler r2 bucket domain add morty-staging-web-assets --domain assets.morty.paradev.biz --zone-id <PARADEV_ZONE_ID> --min-tls 1.2 --force
pnpm exec wrangler r2 bucket cors set morty-staging-web-assets --file config/r2/staging-web-assets-cors.json --force

pnpm exec wrangler r2 bucket create morty-production-web-assets
pnpm exec wrangler r2 bucket domain add morty-production-web-assets --domain assets.morty.paraflow.biz --zone-id <PARAFLOW_ZONE_ID> --min-tls 1.2 --force
pnpm exec wrangler r2 bucket cors set morty-production-web-assets --file config/r2/production-web-assets-cors.json --force
```

The deployment token needs R2 object-write permission for both web asset
buckets. Objects are served with a one-year immutable browser cache policy;
their content hashes make overwriting unnecessary.

### Setup download

`packages/setup/src/setup.ts` owns the TypeScript setup implementation. Its CLI
entrypoint is bundled by Vite into the self-contained `packages/setup/dist/setup.mjs`;
generated JavaScript is not checked in. `pnpm build` builds it before the application.
QR encoding, PNG reading, and QR decoding are included in that bundle and do not require
packages to be installed separately on the user's machine.
The bundle also exports `runSetup(args, host)` for integrations, with cancellable
Runtime and clock ports. The CLI supplies the local OS Runtime implementation.

The Worker serves `/setup.mjs` from the fixed `artifacts/setup.mjs` object in the
existing `CHAT_ATTACHMENTS_APAC` bucket.
The download uses JavaScript content type and requires cache revalidation.
Missing artifacts return `SETUP_ARTIFACT_UNAVAILABLE`
with HTTP 503. Request query parameters never select R2 keys.

The CD token needs R2 object write permission on the existing attachments bucket. CD
uploads the generated bundle before deploying Workers. To seed or refresh local
development R2:

```sh
pnpm build:setup
pnpm exec wrangler r2 object put morty-local-apac-attachments/artifacts/setup.mjs --file packages/setup/dist/setup.mjs --local
```

### Project Durable Objects

After this, a user can reload a Project workspace through the same Chat origin
and have its request authenticated inside that Project's Durable Object. The
public Worker validates the Project ID and resolves one SQLite-backed object by
name. Pairing and transfer redemption use the Project encoded in their tickets;
Slack HTTP and queue deliveries use their validated Project context.

Anonymous creation first creates the Platform Project using Cloudflare request
metadata as the location hint, then initializes the corresponding Chat object.
The Project ID supplies the Durable Object placement hint and selects the APAC or
WNAM attachment bucket. Client-provided region headers have no authority.

Each object owns all relational Chat, identity, and Slack state for one Project.
Schema migrations run transactionally when the object starts. Chat has no D1
binding and no regional backend Workers. The public Worker and object class deploy
together. Runtime variables and secrets come from the corresponding GitHub
Environment and are validated before deployment.

CI validates staging configuration for pull requests, merge groups, and ordinary
main pushes. A manual deployment validates its selected environment. Production
configuration is also validated inside the production deployment job after its
environment approval; it must not gate a staging deployment.

To inspect the deployment after `pnpm build:staging`:

```bash
pnpm exec wrangler deploy --env staging --dry-run
```

Feature logic stays below `packages/worker/src/components`:

- `chat`: safe forwarding for `/mobius/api/*`.
- `instruction-documents`: `/setup.md` and `/pair.md` routes and rendering service.
- `management`: identity, Bot, Project, and Runtime management.
- `slack`: Slack HTTP routes, services, queue processing, D1/R2 adapters, and rate limiting.

Each component exports its Hono subtree from `http/index.ts`; the Worker application only mounts those subtrees.
Cross-component HTTP assembly stays under `packages/worker/src/composition`.
External system adapters stay directly under `packages/worker/src/gateway`; components do not contain gateway directories.
Database table definitions stay under `packages/worker/src/schema`, with one table per file.

Slack is source code in the Worker package, not an embedded package or standalone
deployment. Shared runtime helpers remain directly under `packages/worker/src/infra`.

## Storage

Every Project has a SQLite-backed `ProjectDurableObject`. The validated Project ID
selects the object and its `CHAT_ATTACHMENTS_APAC` or `CHAT_ATTACHMENTS_WNAM` R2
bucket. The object verifies user ownership independently.
The browser persists `{ userId, projectId }`. Chat requests use
`/mobius-cloud/api/chat/projects/:projectId/...`; project-scoped identity and
management requests use `/mobius-cloud/api/projects/:projectId/...`.
The path selects the Project object before authentication; ownership is checked
inside the selected Project. Project headers are not used.
Only one-time pairing and transfer tickets embed Project context; anonymous
credentials are opaque. The object applies the SQL files in
`packages/worker/migrations` automatically and records their versions locally.
Staging and production R2 resources are named in `wrangler.jsonc`.

Slack management requests supply a `projectId` query parameter. Generated Slack
event and OAuth callback URLs, and attachment links, carry a `projectId` query
parameter. Queue deliveries contain `{ projectId, message }` so asynchronous
processing resolves the same Project object. Callback routing does not replace
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
Project-scoped Mobius APIs share `/mobius/api/v1/projects/:projectId/...`, including
Conversation credential operations and `client/session` browser requests. The SDK
places the Project ID in the path for Durable Object routing. Deploy Chat's updated SDK
together with the corresponding Platform endpoint cutover.
New Conversation opens a browser-local draft. Its Harness selector chooses a paired
agent; Chat discovers that agent's settings directly without creating a temporary Session.
The cwd selector beside the model controls browses the selected Runtime and accepts an
absolute path. The Runtime resolves and authorizes that path, and Chat applies the selected
canonical directory only to the new conversation.
First Send materializes the draft as a Mobius Session with the selected
model and approved Bot binding. The Conversation API is the creation and access path for
these Sessions; it is not a separate user-facing chat type. Existing Sessions created by
that path reopen by Conversation ID, including credential refresh, and keep their harness fixed.
First Send keeps the created connection and transitions the draft in place; it
updates the saved URL without removing the sidebar or composer to reconnect.
Chat records materialized Sessions in `chat_managed_session`, keyed and indexed by Project ID,
user ID, Bot ID, access-path provenance and resource ID. The sidebar lists all of them as
Sessions. New Conversation records the first prompt as its title. Native Sessions opens a
two-column discovery and preview dialog;
the directory returns metadata only, selecting an entry fetches its history from
`native-session/:id`; Import resumes it in Chat, while Fork creates a separate native
Session. Cancelling the dialog creates no Chat-managed record. After import or fork, the
result uses the normal Session message surface and can be stopped from the composer.
Imported and forked Sessions reopen by `sessionId` in the saved page URL.
The Worker discovers, imports, and forks native sessions through the Project SDK. Its
`session-access` endpoint issues credentials scoped to the selected Session inside
the user's Project. The browser uses those credentials with the Session SDK to
communicate directly with Mobius; it receives no Runtime-wide host credential.
That Session credential also permits reading and answering interactions for only
the selected Session. Continued Sessions show pending permission and elicitation
requests, restore them after a reload, and reconcile a decision with Mobius before
offering it again. Closing or reloading the pane does not implicitly cancel the
active Turn. Continued Sessions persist the command ID before submission. If a transport
failure leaves acceptance uncertain, Chat displays **Delivery unknown**, never resubmits
automatically, and offers an explicit retry that reuses the original idempotency key. Reload
reconciliation clears that warning when the command is already present in saved messages.
Slack resolves its locally owned Chat Bot binding and uses the same generic Project,
Session, and turn APIs. Bot instructions are injected as trusted Chat-owned context.

## Verification

Run `pnpm lint` and `pnpm typecheck` locally, plus only the tests related to the
change when needed. Product behavior is covered at HTTP and browser boundaries;
tests use deterministic time and stateful fakes rather than request mocks.
`pnpm ci:check` serially reproduces the combined CI validation when diagnosis
requires it.

That command includes combined production TS/TSX coverage and executable dependency
boundaries. `pnpm check:architecture` follows type imports and re-exports. Slack
storage consumes shared records from `components/slack/entity` and execution ports
from `infra`, with no dependency on services, gateways, or composition. Biome's
`useLiteralKeys` rule is disabled because TypeScript's index-signature access rules
require bracket notation for untrusted records. See `TESTING.md` for report scope.
