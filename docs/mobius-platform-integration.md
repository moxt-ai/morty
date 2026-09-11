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
| Staging | https://mobius-platform.paradev.biz/ |
| Production | https://mobius-platform.paraflow.biz/ |

The credentials expire one year after provisioning. Only SHA-256 digests are
stored in D1. Developer memberships were added separately as described below;
no Project has been created. Plaintext
credentials are held outside the repository. `MOBIUS_APP_ID`, `MOBIUS_APP_SECRET`,
and `MOBIUS_BASE_URL` are installed as secrets on `mobius-chat-staging` and
`mobius-chat-production`.

## Remaining requirements

### 1. Project provisioning and developer ownership

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

A short-lived developer token is not a permanent Worker secret; unattended
provisioning needs a separate token-acquisition design.

The configured developer identities can use developer APIs after obtaining a
valid token from the Clerk template. The current implementation requires developer OIDC
for `POST /mobius/api/v1/apps/:appId/projects`, even though the Platform hosting
guide describes AppCredential-based provisioning. `MobiusPlatformAppClient`
currently exposes conversation credential operations only.

Cloud now exposes `GET` and `POST /mobius-cloud/api/management/project`.
The signed-in management page requests the Clerk template token and presents a
Project setup form. The Worker authenticates the Cloud session, requires Clerk
for provisioning, and sends the developer token to `MobiusPlatformDeveloperClient`.
Platform independently verifies that token and Tenant membership.

The Worker derives the client reference and idempotency key from the canonical
Cloud user. The configured App and storage placement are server-owned. The returned
Project mapping is persisted by Cloud user, Platform origin, and App; it survives
reloads and is isolated from other users. Developer tokens are not stored.

Before running this flow, apply `packages/worker/migrations/0003_platform_project.sql`
through Wrangler D1 migrations and configure `MOBIUS_PROJECT_LOCATION_HINT`.
Staging and production use the `apac` location hint; Platform resolves storage placement. Bindings are recorded
in `wrangler.jsonc`. The deployment workflow applies Cloud D1 migrations before
deploying each environment. A live signed-in provisioning check is still pending.
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
plain-text bindings now allow `https://mobius.paradev.biz` for staging and
`https://mobius.paraflow.biz` for production. Preserve these settings in the
Platform deployment configuration when redeploying. The local Platform Wrangler
environment configuration now records both Clerk providers and these origins;
its defaults for local development remain unconfigured.

Live checks on 2026-09-11 confirmed `POST /mobius/api/pairings` returns 404 in
both environments. After configuring the existing Platform conversation-route
CORS middleware, `OPTIONS /mobius/api/v1/client/session`, requesting `GET` with
the `authorization` header from each matching Cloud origin, returns 204 with
the matching `Access-Control-Allow-Origin`. An untrusted origin receives 403
without that header. An unauthenticated GET from an allowed origin receives 401
with that header. These checks passed in both environments.

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
