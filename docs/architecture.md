# Cloud Worker architecture

After this, a maintainer can follow a Cloud endpoint to its service, storage, and
external gateway, and identify the dependencies belonging to the current
request. Users receive the existing authentication, workspace creation, tenant
placement, embedded Slack/Mobius, and queue contracts.

This is a behavior-preserving structural refactor following the explicit-context
pattern in [Slack #22](https://github.com/moxt-ai/mobius-slack/pull/22) and the Hono
guidance in [Mobius #120](https://github.com/moxt-ai/mobius/issues/120).

## Responsibilities

| Responsibility | Cloud representation |
| --- | --- |
| HTTP boundary | Inferred feature route factories in `worker/http/` |
| Application behavior | Authentication and tenant-placement services |
| External capabilities | Clerk, workspace allocator, embedded business, and transport gateways |
| Storage | Configuration validation and regional Slack storage resolvers |
| Domain values | Schemas in `worker/entity/` |
| Composition | Plain infrastructure and dependency factories in `worker/di/` |
| Runtime ownership | Worker entrypoint and Durable Object constructors |

```text
HTTP routes -> services -> gateways
                      -> storage
services and storage -> domain schemas
runtime composition -> concrete adapters
```

## Explicit context subsets

The host supplies configuration, gateway instances, and a logger:

```ts
const cx = createCloudDependencies({ config, gateways, logger });
// cx: { services, storages, gateways, logger, config }
```

Composition constructs storage and services in order and returns a readonly
context. Each component declares only its required subset. Authentication uses
`storages.configuration` and `gateways.clerk`; configuration storage uses
`config.bindings`; the workspace allocator gateway needs only the environment
and allocator binding. The tenant-placement handler accepts
`gateways.organizations` and retains its existing serialized allocation behavior.

There is no service locator, registration metadata, or dependency-injection
container in Cloud-owned composition. A host can supply its own gateway values;
production uses `createCloudInfrastructure`. Context types are dependency
contracts, not evidence of validation or authorization. Binding values remain
untrusted until their owning boundary validates them, and tenant authorization
continues at the service and storage boundaries.

## Route and dependency lifetimes

`createCloudApplication()` composes authentication and workspace sub-applications
directly under `/mobius-cloud/api`. Route handlers stay beside their paths and
read current dependencies from typed Hono bindings. Method guards preserve the
existing 405 responses and Allow headers; response helpers preserve no-store
caching and existing error contracts.

The Worker constructs the Cloud route graph once at module initialization. It
builds current configuration and gateway instances for each fetch or queue event.
Credentials, requests, cancellation signals, tenant results, and binding-derived
clients are not cached in the route graph. External waits retain their existing
cancellation and timeout propagation. Unexpected failures still propagate to
the runtime boundary.

Embedded Slack also constructs its route graph once and supplies its current
context through the API introduced in Slack #22. Cloud's regional D1/R2
resolvers, organization placement lookup, app discovery, and in-process Mobius
dispatch remain part of that request's infrastructure. Embedded business
requests are dispatched directly, retaining streaming and upgrade responses.
The pinned Mobius package continues to own its own composition and cleanup.

Tenant placement stays inside its Durable Object, including its serialization
and authoritative Clerk operations. It is not moved into Worker-global state.

## Verification

Run `pnpm check`. Existing Worker integration scenarios cover authentication,
workspace creation, tenant authorization, Slack storage selection, and errors.
Tenant-placement scenarios cover allocation, retries, and cancellation through
its request boundary. Browser scenarios cover the signed-in workspace journeys.
Mechanical constructor and routing changes reuse these product-boundary tests.
