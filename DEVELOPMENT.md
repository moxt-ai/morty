# Development Guide

## Local Development

Use Node.js 24.20.0 (`.nvmrc`) and pnpm 11.25.0 (`packageManager`). Run commands
from the repository root:

```bash
pnpm install
pnpm dev
pnpm check
```

`pnpm dev` serves the React app at `http://localhost:5173` and runs its API in
Cloudflare's local Workers runtime. `pnpm check` generates Worker types, checks
TypeScript, builds the app and Worker, runs Biome and the English-only file
check, runs Vitest coverage and workspace browser scenarios, and checks unused code and dependencies with Knip.

### Clerk configuration

Copy `.dev.vars.example` to `.dev.vars`. Set `CLERK_PUBLISHABLE_KEY` to the
Clerk publishable key and `CLERK_JWT_KEY` to the PEM public key from the same
Clerk instance. Encode PEM line breaks as `\n` inside a quoted value. Set
`APP_ORIGIN` to the exact browser origin, without a trailing slash.

The browser reads only the publishable key from `GET /mobius-cloud/api/config`.
It obtains a session token from Clerk and sends it as a Bearer token to
`GET /mobius-cloud/api/session`.
The Worker verifies the signature, expiry, and authorized party locally using
Clerk's backend SDK, rejects pending sessions, and returns the user ID, session
ID, and active organization ID (or null). This proves identity; future business
endpoints must separately authorize workspace access.

Workspace creation requires a matching Clerk development `CLERK_SECRET_KEY`.
Never prefix a secret key with `VITE_` or commit it. Missing configuration fails closed with HTTP 503; invalid
or missing session tokens receive HTTP 401. Keep the configured JWT public key
in sync when Clerk rotates signing keys. Local verification does not check
server-side revocation on every request; tokens remain valid until expiry.

Deployed Clerk configuration is stored on each Cloudflare Worker as described
below. Staging requires a Clerk development instance; production requires a
separate production instance. Never reuse development keys in production.

Worker types are generated from `wrangler.jsonc` into the ignored
`worker-configuration.d.ts` file. Run `pnpm typegen` after changing bindings or
the compatibility date. Build output and local Worker state are ignored too.

### Local storage and Cloudflare Tunnel

The default local Worker uses the staging logical placement inventory with local
APAC/WNAM D1 and R2 bindings. Initialize the local databases before verification:

```bash
pnpm exec wrangler d1 migrations apply D1_SHARD_APAC_01 --local
pnpm exec wrangler d1 migrations apply D1_SHARD_WNAM_01 --local
pnpm exec wrangler d1 migrations apply DIRECTORY_DATABASE --local
```

For an HTTPS origin, start `cloudflared tunnel --url http://localhost:5174`.
Set `APP_ORIGIN`, `SLACK_SERVER_BASE_URL`, `MOBIUS_BASE_URL`, and
`AUTHENTICATION_BASE_URL` in `.dev.vars` to the returned HTTPS origin, then run
`pnpm dev --port 5174`. Restart Vite after changing secrets. A new quick tunnel
gets a new origin, so update those values when restarting the tunnel.

Use the Clerk session claims described in [the storage contract](docs/storage.md)
and create a new workspace through Cloud. Existing Organizations without placement
cannot access Cloud tenant storage. D1/R2 and Durable Objects run locally; Clerk
sign-in and Organization creation use the configured development Clerk instance.

The root toolchain owns `cloud/` and the root development files. Business repositories keep their own checks and SQL files. Cloud CI additionally
loads pinned Mobius and Slack sources to validate their shared-shard migrations.
Cloud CD applies those migrations before deploying its own Worker. Existing
standalone business deployments remain owned by their original repositories.

## Worker architecture

The Cloud Worker follows Slack's constructor-injected layering. `worker/application.ts`
adapts Cloudflare fetch and queue events and owns the lifetime of the `typed-inject`
container built by `worker/di/create-application.ts`.

- `controller/` owns HTTP routing, request headers, and response status mapping.
- `service/` owns authentication policy and validated session results.
- `entity/<domain>/` defines shared domain schemas and inferred types, plus database row schemas when Cloud owns persistence.
- `storage/` reads and validates deployment configuration from Worker bindings.
- `gateway/` owns Clerk token verification and the embedded Mobius/Slack integrations.
- `infra/` contains shared HTTP response mechanics.

Cloud has no authentication database: business persistence remains in the embedded
Mobius and Slack storage adapters. Configuration storage exposes only validated
authentication settings to the service. The public Worker entrypoint remains the
boundary exercised by the existing authentication integration scenarios.

## Workspace UI

A workspace is a Clerk Organization. The browser uses Clerk's authenticated
Organization API for membership-scoped listing, creation, selection, and deletion.
Clerk enforces membership and permissions for these operations. Enable Organizations
and administrator deletion in each instance; organization selection must remain
optional so new users can reach the workspace list before creating one.

TanStack Router loaders own list and detail requests; explicit form submissions own
mutations and route invalidation. Zustand owns only dialog state. The Clerk shell
creates the workspace router for the active session. Components subscribe and render
without `useEffect` data fetching. Requests have deadlines and inherit route cancellation.
The Clerk SDK does not expose HTTP cancellation, so cancellation stops waiting;
mutations are never automatically retried because their remote result may be unknown.

Cloud browser code follows the same package pattern and core stack as Slack:
`packages/web` owns the Vite and Clerk shell, `packages/web-core` owns reusable
workspace behavior, TanStack Router owns browser routing, and Valibot validates
untrusted boundary data.

Workspace machine connections survive reloads in the same browser. Cloud stores
only the channel ID under the signed-in user and workspace; Mobius continues to
own the channel credential. The workspace loader checks membership before
restoring and reauthorizing the channel. A failed restore shows an error instead
of silently creating a new pairing request.

For a channel paired before workspace persistence was introduced, open
`/workspaces/<workspace-id>?channel=<channel-id>` in the original paired browser.
Successful channel authorization saves the workspace association; later visits
to the plain workspace URL restore it. The channel ID alone grants no access.

## Cloudflare Deployment

### Browser error monitoring

The browser initializes Sentry before React renders. Uncaught errors, unhandled
promise rejections, route errors, and unexpected workspace mutation or sign-in
bootstrap failures are reported while existing recovery screens remain available.
Expected workspace validation, authorization, and not-found errors, and aborted
requests, are not reported as application failures.

Staging uses the `paraflow/mobius-cloud-testing` Sentry project; production uses
`paraflow/mobius-cloud`. Each GitHub deployment environment defines `SENTRY_DSN`,
`SENTRY_ORG`, and `SENTRY_PROJECT` as variables. `SENTRY_AUTH_TOKEN` is a GitHub
Actions secret used only during the build. Use a dedicated organization CI token
with `org:ci` scope rather than an expiring interactive login.
The deployment fails if any required Sentry setting is absent or a Sentry upload fails.

The build embeds the public DSN, environment, and `mobius-cloud@<commit>` release
identifier. It uploads browser source maps to the selected project and removes
them from the public assets before deployment. Never prefix the upload token
with `VITE_`; only the DSN is public.

Browser tracing samples all staging navigations and 10% of production navigations.
It records browser performance and HTTP timings; Worker tracing is configured
separately. The browser does not add tracing headers to outgoing requests.
Session Replay and console/DOM breadcrumbs are disabled. Request bodies,
headers, cookies, user fields, and URL query strings are removed from error
reports; URL queries are also removed from navigation and HTTP breadcrumbs.

Local development leaves Sentry disabled by default. To verify real ingestion,
set `VITE_SENTRY_DSN` to the testing project's DSN, `VITE_SENTRY_ENVIRONMENT` to
`staging`, and `VITE_SENTRY_RELEASE` to a distinct verification release before
starting Vite. Trigger a controlled browser error in a disposable browser session,
then verify its environment, release, and stack trace in the testing project.
Do not use real conversation content or credentials in verification events.

Deployment uses two isolated Workers:

| Environment | Worker | Trigger |
| --- | --- | --- |
| `staging` | `mobius-cloud-staging` | Successful checks after a push to `main`, or manual dispatch |
| `production` | `mobius-cloud-production` | Successful automatic staging deployment, followed by a 15-minute environment wait; also manual dispatch |

Pull requests only run checks. Like Mobius, the repository allows automatic
squash merging after its required checks pass. Enable auto-merge on a reviewed
pull request to merge it once those requirements are satisfied.

Check and deployment jobs cache the pnpm store, including business dependencies. Cache keys
include the root lockfile and pinned business source action. Browser checks also cache Chromium's headless
shell by operating system, architecture, and Playwright version. Installation
reuses cached binaries while ensuring system libraries are present on each fresh
runner. Cache misses download only the headless shell required by the scenarios.
Deployments are serialized per environment and
are not canceled while running. Both Workers serve the app and assets without
database bindings. Local development uses the default `mobius-cloud-local`
configuration and `.dev.vars`; it is not a deployment target.

The physical D1 inventory is maintained in `infra/d1-shards.json`; regional R2
buckets are listed in `infra/r2-buckets.json`. These
pre-created databases belong to the Cloud deployment infrastructure, but the
Cloud Worker does not bind them. Business services own their tables and migration
files. See [the storage contract](docs/storage.md) before connecting a service
or releasing business migrations to the shared shards. Cloud CD reads its own
versioned inventory and applies both businesses' migrations before deploying.
Existing standalone service deployments remain independent.

### Account and credentials

The configured account is Paraflow Cloud (`95af7a3d67be8c49b1619544e3ce53c0`).
Its environment URLs are `https://mobius.paradev.biz`
and `https://mobius.paraflow.biz`.

Run `pnpm exec wrangler login` to authorize local access, then
`pnpm exec wrangler whoami` to list accessible accounts. Set
`CLOUDFLARE_ACCOUNT_ID` explicitly when deploying locally to an account with
multiple organizations. Logging in does not configure CI credentials.

Create GitHub environments named `staging` and `production`. Each environment
needs a `CLOUDFLARE_API_TOKEN` secret: a Workers deployment token with D1
Edit, scoped to the configured Cloudflare account. Also set `CLERK_SECRET_KEY`
in each GitHub environment (`sk_test_...` for staging and `sk_live_...` for
production). Deployment uploads this key to the selected Worker before verifying
runtime configuration. Configure the Sentry settings described above as well.
Restrict deployment to `main`. Configure a 15-minute wait timer on the
`production` environment. GitHub enforces this delay before starting its job,
including manual production releases; waiting does not occupy a runner.
The account ID, deployment targets, and public deployment links are versioned
in the repository; GitHub environment variables are not required.

Cloudflare stores the Worker runtime configuration. Deployment synchronizes
`CLERK_SECRET_KEY` from GitHub environment secrets; provision the other names on
each Worker before deploying code that requires them:

| Worker setting | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact browser origin, without a trailing slash |
| `CLERK_PUBLISHABLE_KEY` | `pk_test_...` for staging; `pk_live_...` for production |
| `CLERK_ISSUER_URL` | Clerk issuer for the same environment |
| `CLERK_JWT_KEY` | Corresponding PEM public key, with actual line breaks |
| `CLERK_SECRET_KEY` | Corresponding Clerk Backend API key used only to create Organizations with storage placement |
| `AUTHENTICATION_BASE_URL` | Identity and authorization service URL |
| `MOBIUS_BASE_URL` | Mobius service URL |
| `SLACK_SERVER_BASE_URL` | Slack application's public base URL |
| `SLACK_MOBIUS_AUTH_TOKEN` | Service-to-service authentication token |
| `SLACK_OAUTH_STATE_SIGNING_KEY` | Slack OAuth state signing key |
| `SLACK_TOKEN_ENCRYPTION_KEY` | Base64-encoded 32-byte key for stored Slack credentials |

Configure these compact custom claims under **Clerk Dashboard → Sessions →
Customize session token** so embedded businesses receive the active tenant's
validated logical placement:

```json
{
  "mobius_d1_shard_id": "{{org.public_metadata.mobiusCloud.placement.d1ShardId}}",
  "mobius_r2_bucket_id": "{{org.public_metadata.mobiusCloud.placement.r2BucketId}}",
  "mobius_placement_revision": "{{org.public_metadata.mobiusCloud.placement.revision}}"
}
```

Use the corresponding staging or production Clerk instance. These logical IDs
are routing data, not credentials or proof of tenant authorization.

The deployed Cloud Worker also requires the inventory-derived bindings declared
in `wrangler.jsonc`: `D1_SHARD_<logical ID>` for every D1 shard and
`R2_BUCKET_<logical ID>` for every regional object bucket. Slack selects these
bindings through its application injector only after placement has been resolved
and validated.

These settings are currently stored as Worker secrets, including the public
keys and URLs. The Clerk secret key is required only by the tenant placement
allocator and is synchronized from GitHub during deployment. Keep runtime secrets
out of the frontend bundle. The browser obtains the publishable key from the running Worker's
configuration endpoint.

`wrangler.jsonc` declares the required secret names for each deployed environment
and enables `keep_vars`. CI builds the selected environment, verifies the account,
Worker name, and presence of its required secret names, then migrates databases
and deploys. This check does not retrieve or validate secret values; validate
values when provisioning or rotating them. Deployments inherit the existing
Worker settings and do not generate or upload a secrets file.

Use Cloudflare's dashboard or `wrangler secret put` to provision and rotate runtime
settings. Preserve the encryption key when moving configuration: replacing it
without migrating stored ciphertext makes existing Slack credentials unreadable.

### Build and release

```bash
pnpm check
pnpm build:staging
pnpm build:production
```

The Cloudflare Vite plugin selects the environment at **build time** using
`CLOUDFLARE_ENV`. `wrangler deploy` uses the generated build configuration;
do not append `--env` to deploy an already built app.

Staging deploys automatically when a pull request is merged to `main`.
After that CI run succeeds, the separate `Production` workflow deploys the
same commit following the environment's 15-minute wait. Failed or canceled CI
runs and pull request checks do not trigger production. The wait begins when
the production job is triggered, so queueing can make the total delay longer.
Production waiting does not block subsequent staging checks or deployments.
An active production run is not canceled by a newer merge; only the newest
pending automatic production run is retained.

To release manually, run the `CI` workflow on `main` and select
`production`. This repeats all checks and uses the same environment wait.
Manual CI runs do not trigger another automatic production release.
Cloud CD builds Cloud, migrates both businesses across every selected shared D1
shard, then deploys the Cloud Worker. A failed migration prevents deployment.
It does not deploy existing standalone Mobius or Slack Workers or migrate their
databases. Their original CI workflows, domains, and storage bindings remain in use.

To update a migration version, update its business submodule commit and the
corresponding SHA in `.github/actions/business-sources/action.yml` together. CI
rejects a mismatch. The business repositories expose source-only internal actions
to the organization, so GitHub can download the pinned revisions using temporary
scoped tokens without a stored cross-repository PAT. Business CI continues to
check and deploy its own standalone service independently; Cloud CI verifies the
new shared-shard migration composition.

For a local release, authenticate Wrangler and use `pnpm deploy:staging` or
`pnpm deploy:production`. The account ID is already in the repository config.
Provision missing settings on an existing Worker with
`pnpm exec wrangler secret put NAME --config wrangler.jsonc --env staging`
(or `production`). The command reads the value interactively. An entirely new
Worker requires a one-time initial deployment with a private `--secrets-file`;
subsequent releases preserve its settings without that file. The local
`.dev.vars` file is only for development, not deployed credentials.


## Execution Boundary

Mobius Cloud runs its control plane on Cloudflare Workers. The service performing a side effect is the final trusted enforcement point. Local Agent operations remain authorized by the local Mobius process.

Every operation that can affect the local machine must follow the same pipeline:

```text
untrusted input
  -> schema validation
  -> normalization and target resolution
  -> capability and target authorization
  -> execution
  -> audit event
```

Define external boundary contracts with Zod schemas and derive their TypeScript types with `z.infer` instead of duplicating interfaces. Parse incoming values from `unknown`; type assertions are never validation.

Keep validation and authorization distinct. Schema validation establishes that a request is well formed; authorization establishes that the active session may perform that specific operation. Neither result implies the other.

For values whose meaning can change after resolution, check both forms. Examples include symbolic links, relative paths, redirects, hostnames, executable lookup, and command arguments. Authorization must be repeated at the local execution boundary immediately before the side effect.

## Make Illegal States Unrepresentable

Use an abstract state base class with one concrete class per lifecycle state:

```ts
abstract class SessionState {
  abstract readonly kind: string;
}

class ConnectingSessionState extends SessionState {
  readonly kind = "connecting";
}

class ActiveSessionState extends SessionState {
  readonly kind = "active";
  readonly capabilities: ReadonlySet<Capability>;
  readonly sessionId: string;

  constructor(sessionId: string, capabilities: ReadonlySet<Capability>) {
    super();
    this.sessionId = sessionId;
    this.capabilities = capabilities;
  }
}

class ClosedSessionState extends SessionState {
  readonly kind = "closed";
  readonly reason: CloseReason;

  constructor(reason: CloseReason) {
    super();
    this.reason = reason;
  }
}
```

Do not model the same concept as unrelated optional fields:

```ts
// Invalid combinations are possible: active without a session ID, or closed with capabilities.
interface SessionState {
  readonly active?: boolean;
  readonly sessionId?: string;
  readonly capabilities?: ReadonlySet<Capability>;
  readonly closeReason?: CloseReason;
}
```

State transitions should accept only valid source-state classes and return a complete destination state. Consumers branch with `instanceof` and must reject unknown state classes explicitly.

Use optional properties only when absence is meaningful within the same state. Use `null` only when an explicit empty value is part of the domain. Reserve `Partial<T>` for update payloads, never for lifecycle or protocol states.

## Protocol, Domain, and Port Contracts

Treat protocol messages, domain values, and ports as contracts. Their properties must be `readonly` so consumers cannot mutate shared state behind the owner's back.

Declare callbacks and port operations with function property syntax:

```ts
interface HarnessPort {
  readonly connect: (
    request: ConnectRequest,
    signal: AbortSignal,
  ) => Promise<Session>;
}
```

Do not use method syntax for these contracts. TypeScript intentionally excludes method parameter positions from `strictFunctionTypes`, while function properties receive the stricter variance check.

This rule applies to protocol, domain, and port contracts. It does not require every short-lived local object or mutable implementation detail to be immutable.

## Function Design

Function signatures must express intent precisely. Prefer purpose-specific functions and domain types over boolean mode flags or broad parameter objects. A function must do only what its name promises.

## Cancellation, Timeouts, and Resource Ownership

Every asynchronous operation that waits on an external system accepts an `AbortSignal`. A finite operation applies an explicit timeout appropriate to its boundary; a long-lived stream applies connection and liveness deadlines so no individual wait is unbounded. Callers propagate the same cancellation intent through runtime and adapter layers instead of creating disconnected cancellation trees.

Cancellation is a distinct outcome. Do not convert it into a generic network or runtime failure, and do not retry it. A retry policy must be bounded, cancellable, and restricted to failures and operations that are safe to repeat. Never retry an operation after its side effects are known to have occurred or when the outcome is indeterminate unless the operation has an explicit idempotency contract.

The code that acquires a resource owns its release unless ownership is explicitly transferred in the type contract. Connections, streams, subprocesses, locks, timers, subscriptions, and concurrency slots must be released on success, failure, and cancellation. Prefer `try`/`finally` or a scoped helper that makes cleanup structurally unavoidable.

## Typed Error Contracts

Errors crossing subsystem, port, or protocol boundaries require a stable machine-readable code and a safe human-readable message. Model outcomes that require different handling separately, including cancellation, timeout, retryable failure, and terminal failure.

Consumers must branch on the error type or code, never by matching message text. Human-readable messages may change without breaking behavior.

Do not catch, ignore, or replace a failure unless the current boundary can fully handle it. Otherwise, propagate it or translate it once into the owning boundary's error contract, preserving the original failure as the cause.

Do not expose secrets, credentials, raw remote payloads, or unnecessary local paths in protocol error messages. Unexpected exceptions must be normalized at the boundary where they leave the process or subsystem.

## Abstraction Discipline

Start with the simplest direct implementation of the current behavior. Keep control flow local and linear when that makes the operation easier to read.

Introduce an abstraction only when at least one of these conditions is true:

- It isolates a real external boundary, such as a transport, harness, clock, or persistent store.
- A second real use case requires interchangeable behavior.
- Current duplication has been demonstrated and the abstraction makes the code simpler.

Do not create layers, factories, generic frameworks, configuration switches, or extension points for hypothetical future requirements. Remove unused indirection. Extract details when they obscure the caller's main control flow, but keep them inline when they are the function's primary job.

## Defensive Code

After the local execution boundary has converted untrusted input into a trusted domain type, rely on that type and its established contract instead of repeating checks or adding fallbacks for states the contract excludes. Apply the boundary pipeline again when new untrusted data enters or resolution changes a value's security meaning.

Add defensive branches, compatibility paths, or fallback behavior only for a documented external failure mode, security requirement, or observed production risk. An invariant violation must fail visibly instead of being converted into an empty value, default result, or alternate behavior.

## Comments

Code should be self-explanatory through names, types, and structure. Implementation comments explain constraints, tradeoffs, compatibility requirements, or why an apparently simpler approach is unsafe; they do not merely restate what the code does. Public contract documentation describes purpose, supported usage, and observable behavior.
