# Mobius Platform integration

## Provisioned environments

The Platform route cleanup was merged in Mobius PR #161 and the Clerk/CORS
deployment configuration in Mobius PR #164. The Cloud SDK migration
is still in progress.
Both control-plane databases were bootstrapped on 2026-09-11 with an active
Tenant, an active Mobius Chat App, a default AppCredential, and two audit events.
The credential digest was verified against the locally retained secret.

| Environment | Endpoint |
| --- | --- |
| Staging | https://mobius.moxt.ws/ |
| Production | https://mobius.moxt.ai/ |

### Chat runtime configuration

Both Chat environments connect to the production Platform origin,
`https://mobius.moxt.ai`. Chat staging and production use separate Apps and
AppCredentials within that Platform environment; Chat staging does not connect
to the staging Platform endpoint listed above.

| Chat Worker | `MOBIUS_BASE_URL` |
| --- | --- |
| `mobius-chat-staging` | `https://mobius.moxt.ai` |
| `mobius-chat-production` | `https://mobius.moxt.ai` |

On 2026-09-14, each AppCredential was authenticated and authorized for its App's
Project provisioning endpoint before updating `MOBIUS_BASE_URL`, `MOBIUS_APP_ID`,
and `MOBIUS_APP_SECRET` together on the corresponding Chat Worker. Verification
used an unavailable storage location and created no Project. Cloudflare confirmed
all three secret updates for each Worker.

These values are maintained as Cloudflare Worker secrets. `MOBIUS_APP_SECRET`
must contain the full `mapp_…` AppCredential returned when a key is created,
not its public Key ID. A credential must belong to an App in the configured
Platform environment.

AppCredentials do not expire. Only SHA-256 digests are
stored in D1. Developer memberships were added separately as described below;
no Project has been created. Plaintext
credentials are held outside the repository. `MOBIUS_APP_ID`, `MOBIUS_APP_SECRET`,
and `MOBIUS_BASE_URL` are installed as secrets on `mobius-chat-staging` and
`mobius-chat-production`.

## Remaining requirements

### 1. App-authenticated Project provisioning

Both deployed Platform Workers now trust Clerk with provider ID `clerk`, audience
`mobius-platform`, and signing algorithm `RS256`:

| Environment | Issuer | JWKS URL |
| --- | --- | --- |
| Staging/dev | `https://smashing-spider-8574.clerk.accounts.dev` | `https://smashing-spider-8574.clerk.accounts.dev/.well-known/jwks.json` |
| Production | `https://clerk.mobius.paraflow.biz` | `https://clerk.mobius.paraflow.biz/.well-known/jwks.json` |

Discovery metadata, public RSA keys, and the deployed settings read-back were
verified on 2026-09-11. Signed-token authentication still needs an end-to-end check.
Create a Clerk JWT template named `mobius-platform` with `aud: "mobius-platform"`.
After sign-in, request it with `getToken({ template: "mobius-platform" })` and send
it as a Bearer token with `x-mobius-oidc-provider: clerk` to developer APIs.

Developer OIDC is the selected Project provisioning approach. On 2026-09-11,
active `developer` memberships and their audit events were created and verified
in the existing staging and production Tenants. Environment-specific user and
resource identifiers are maintained in deployment configuration and Platform
storage rather than this document.

`POST /mobius-cloud/api/identity/anonymous-users` creates the identity, provisions
its internal Project, creates a Bot through `MobiusBotOwnerClient`, and persists
ownership before returning `{ token, userId, bot }`. The Worker uses
`MobiusPlatformAppClient` with its server-held AppCredential. Users never configure
Projects in the web application: the browser opens headerless Chat directly.
Slack navigation and the manual Bot claim/Project setup screens are hidden or removed.
Clerk remains an optional identity binding; OIDC is for Platform developer operations.

Platform's Project creation route composes AppCredential and developer OIDC
middleware. A standalone AppCredential authentication service verifies credentials;
the control-plane service authorizes App scope and provisioning permissions.
App provisioning requires an App-wide credential with the full server permission
set. Selected-Project and limited-permission credentials cannot provision Projects.

The Worker derives the client reference and idempotency key from the canonical
Cloud user. The App and logical location hint are server-configured. Platform maps
the hint to its storage resources and persists the resolved placement. The returned
Project mapping is persisted by Cloud user, Platform origin, and App; it survives
reloads and is isolated from other users. AppCredentials stay server-side.

Before running this flow, apply `packages/worker/migrations/0003_platform_project.sql`
through Wrangler D1 migrations and configure `MOBIUS_PROJECT_LOCATION_HINT`.
Staging and production use the `apac` location hint; Platform resolves storage placement. Bindings are recorded
in `wrangler.jsonc`. The deployment workflow applies Cloud D1 migrations before
deploying each environment. Staging anonymous provisioning and persistence after
reload were verified with `agent-browser` against the deployed services.
Subsequent Bot operations must authorize the user's saved Project
and Bot before calling Mobius with the AppCredential.

### 2. Worker SDK and authentication

The Worker now depends on the local `third-party/mobius/packages/mobius-sdk` package
and uses `@moxt-ai/mobius-sdk/platform` for Project provisioning. The Platform
subpath is configured in TypeScript and Vite. Use `@moxt-ai/mobius-sdk/server` for Bot, Runtime,
Session, and Conversation operations, and `@moxt-ai/mobius-sdk/platform` for
conversation credential lifecycle. Add the server and browser subpath aliases
as those consumers migrate.

Replace `x-mobius-app-id` / `x-mobius-app-secret` authentication with
`Authorization: Bearer mapp_...`. Keep the AppCredential server-side. Retain
endpoint validation, cancellation, deadlines, response validation, and sanitized
typed errors at Cloud's boundary.

### 3. Runtime and Bot management

Chat now exposes `POST /mobius-cloud/api/management/runtime-pairings` with an
`idempotencyKey` and `GET /mobius-cloud/api/management/runtime-pairings/:pairingId`.
Both authenticate the Cloud user, resolve their persisted Project mapping, and
call the server SDK with Chat's AppCredential. Responses include the actual
Runtime pairing identifiers and relay URL; AppCredentials are never returned.
An anonymous user receives their Bot automatically and can request pairing without Clerk.
Staging pairing issuance was verified through the browser against the deployed
Platform. CLI completion and the Bot/conversation journey still need verification.

### Deployment repair

The Platform deployment runner migrates the configured regional shards and the
control-plane database. Existing remote shards use the `mobius_migrations` ledger;
the Platform Wrangler configuration must use that same ledger.

Chat migration `0001_management.sql` creates management tables for deployments
whose recorded initial migration predates those tables, before identity backfill.
The renamed staging Worker has the required runtime settings and owns the existing
Slack queue consumer. The Chat landing view resolves its Bot from the authenticated
backend and does not require browser build-time App configuration.

`packages/worker/src/gateway/mobius-gateway.ts` still uses the legacy `/pairings`
bootstrap, which Platform explicitly returns 404 for. Use the SDK's
Project-scoped `runtimePairings.create/read` and `runtimes.list` operations.
Provision a Project first, show the returned pairing code, and retain the returned
Runtime ID and online state independently.

Move browser Bot-owner operations and browser-local owner credentials behind
authorized Cloud management routes. Use the server Bot client for creation,
behavior, execution binding, and connector operations. Adapt Slack's setup and
pairing responses to the current resource contracts.

### 4. Conversation-scoped browser access

`packages/worker/src/components/chat/mobius-app-service.ts` calls
`/mobius/api/v1/access-tokens`, which is not a Platform API. First create or reopen
an authorized Conversation and Session, then issue its short-lived `mconv_...`
credential with `MobiusPlatformAppClient.issueConversationAccessCredential`.

Persist the actual Project, Bot, Conversation, Session, credential ID, and expiry
associations. Rotation returns a new credential ID; the current regeneration path
assumes the ID stays unchanged and must be migrated along with storage.

Use `@moxt-ai/mobius-sdk/browser` and `createMobiusConversationSession` in web for
messages, turns, history, configuration, interactions, artifacts, and events.
Replace the current Project clients and channel WebSocket path in
`packages/web/src/services/chat/mobius-transport.ts`. The restricted browser SDK
does not provide Runtime pairing, Bot management, native-session browsing, agent
installation, or workspace discovery; those features need authorized backend
routes where supported by the Platform API.

### 5. Deployment configuration

Each environment's AppCredential, Platform endpoint, and App ID are installed on
the matching Chat Worker. The Platform Workers' `MOBIUS_PLATFORM_ALLOWED_ORIGINS`
plain-text bindings use `["*"]` for public browser access in both environments.
Platform serves independent applications as well as Chat. CORS reflects the
requesting origin; scoped credentials and permissions authorize each operation.
Cookie-based credential sharing is not enabled. Preserve this policy in the
Platform deployment configuration when redeploying.

Live checks on 2026-09-11 confirmed `POST /mobius/api/pairings` returns 404 in
both environments. The conversation-route CORS contract permits
`OPTIONS /mobius/api/v1/client/session`, requesting `GET` with the `authorization`
header, from any browser origin. A successful preflight does not authorize the
actual request: an unauthenticated GET must still return 401, and a credential
without the requested operation's permission must still be denied.

The deployment workflow validates the `mobius-chat-*` Worker names configured
in `wrangler.jsonc` before checking required remote runtime settings.

### 6. Acceptance slice

After this, a user can pair a Runtime, create a Bot, open a Conversation, send a
message, and see the agent reply and retained history after reload.

Start with a failing HTTP/browser acceptance scenario using a stateful Platform
peer through the production SDK transport. Cover user isolation, pairing,
credential issuance/rotation/revocation, messages, history, and event-stream
cancellation. Existing tests exercise legacy contracts, so a passing baseline
typecheck does not prove Platform compatibility. Run `pnpm check` after migration,
then exercise the provisioned staging service with a real paired Runtime.

### Agent setup skill

`/setup.md` is the standalone entry point for testing and external sharing
(such as Twitter), not a web UI instruction: resume the local identity or create
an anonymous user and Bot, pair a Runtime, and return a one-time browser handoff.
`/pair.md?token=...` is copied from every web workspace. First-time visitors
receive a browser-held identity and Bot before the instruction is shown. Its opaque,
24-hour ticket is issued for the authenticated anonymous or Clerk user and target
Bot. Explicit POST redemption atomically consumes it and issues a separate local
credential for that user. It never creates another Bot. Reading the document does
not consume the ticket. Pairing tickets and browser transfers have separate stores
and redemption endpoints.

The Worker renders both documents from `templates/`, substituting `APP_ORIGIN`
or the request origin before serving them. Template placeholders are not public assets.
Both documents use `public/setup.mjs` through just two commands:
`pair --token <one-time-ticket> --harness <agent-id>` and `setup --harness <agent-id>`.
They handle private configuration persistence, identity validation, resumable
Runtime pairing, detached Runtime launch, binding, and readiness, with timestamped
JSON progress. Dependencies and agent authentication are
handled by the calling agent. The pair flow returns the existing Chat page; only
standalone setup issues a browser transfer, also valid for 24 hours. Never expose durable credentials or
consume the user's final browser link. Configure edge access-log exports to redact
the `token` query parameter on `/pair.md`; application audit events contain IDs only.
