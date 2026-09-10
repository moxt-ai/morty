# Slack HTTP architecture

After this, a maintainer can start at a Slack endpoint, follow its application
operation to the external adapter or storage, and see which dependencies belong
to the current request. Users receive the same paths, authorization, response
contracts, file downloads, event acknowledgements, and cancellation behavior.

This is a behavior-preserving structural refactor following
[Mobius #120](https://github.com/moxt-ai/mobius/issues/120). It does not adopt Hono
RPC or replace the public SDK.

| Responsibility | Representation |
| --- | --- |
| HTTP boundary | Inferred, chained feature route factories in `packages/api/src/http/` |
| Application orchestration | Services owning authorization, workflows, and lifecycle decisions |
| External capability | Gateway and infrastructure contracts |
| Persistence | Semantic storage components and runtime database/attachment adapters |
| Runtime validation and domain values | Boundary schemas and domain entities |
| Composition | `createSlackDependencies` and each host's plain infrastructure values |

```text
HTTP routes -> services/use cases -> gateways <- runtime adapters
services/use cases -> domain values
storage adapters -> domain values
```

## Route composition

Feature routes declare handlers beside their paths and return the chained Hono
value without a broad `Hono` annotation. `createSlackApplication` composes completed
sub-applications directly under
`/mobius-slack/api` and installs the existing error mapping. No framework subclass
or injectable HTTP controller is needed. The file boundary remains a direct
request handler so its existing streaming and error behavior is preserved.

HTTP decoding and response mapping belong in these modules. Services, gateways,
and storage do not depend on Hono `Context`; portable API code does not import
Cloudflare binding types. Validated HTTP input does not replace authentication,
tenant resolution, or service/storage authorization.

## Application structure and request lifetime

The standalone Worker and Cloud host construct their Hono route graphs at module
initialization. Handlers read the current `SlackContext` from typed Hono bindings
for each request. No route closure captures a credential, principal,
tenant, request, or cancellation signal.

Each fetch or queue event builds its own infrastructure from current Worker
bindings. `createSlackDependencies` constructs storage and services explicitly
from caller-supplied gateways, configuration, and logger. It returns a readonly
`cx` containing `services`, `storages`, `gateways`, `logger`, and `config`. Derived
configuration, clients, and storage resolvers are never cached globally. Requests
pass `request.signal` to application operations and external waits. Event intake
and queue processing await their authoritative work; assets remain owned by the
Worker host. A Node host may retain stable infrastructure for its owned lifetime
and must release any resources it acquires.

## Context subsets

Each service, storage component, and gateway declares its own readonly subset
of the context in its constructor signature. For example, Slack event intake
requires only `storages.slackEventStorage` and `gateways.queue`; signed event
handling requires `gateways.clock`, `gateways.slackAppDirectory`, and
`services.intake`. A larger context satisfies these types structurally without
exposing additional dependencies inside the component.

`config` contains settings, `gateways` contains external capabilities and runtime
ports, `storages` contains semantic persistence operations, and `services`
contains application behavior. Gateway constructors also take narrow contexts:
the Mobius gateway needs its base URL, HTTP/relay transports, and logger.

The composition root constructs dependencies in order and passes completed
subsets to constructors. It does not mutate an incomplete context, use a service
locator, or depend on container tokens. Tests provide stateful external adapters
through the same caller-owned gateway fields as production hosts.

## Retained application responsibilities

Services are retained for behavior rather than naming symmetry:

- Installation and management services own OAuth, app registration, token
  management, and authorization.
- `MobiusConnectionService` binds an independently configured Slack bot to a
  Mobius Bot connection. It authorizes Slack ownership, establishes scoped
  connector access, stores the encrypted credential, and replaces prior bindings.
- Identity and account-binding services validate principals, tenant placement,
  and signed link state.
- Event services verify signed input and resolve app ownership
  before intake; intake owns deduplication and durable dispatch.
- Conversation, context, processor, delivery, and queue services own
  conversation lifecycle and Slack/Mobius orchestration.
- Bot tools and file services enforce capability and tenant access and own
  external Slack operations and attachment delivery.

Use the existing API integration scenarios and `pnpm check` to verify these
contracts. Tests supply request dependencies through the same Hono environment
boundary used by the Worker.

## Host workspace pairing

`MobiusGateway.createPairing(credential, signal, tenantId)` receives the tenant ID
from Slack's authenticated human principal. The pairing route never takes this
context from request bodies, query parameters, or tenant headers. Cloud can
override this gateway operation to create a workspace-scoped pairing using its
own authorized execution boundary. The tenant ID is context, not a credential or
permission to bypass host authorization.

The default gateway continues forwarding the bearer credential to Mobius's
`POST /mobius/api/pairings` endpoint with an empty JSON object; it does not send
the tenant ID as a client assertion. Hosts retain cancellation and response
contracts when overriding the operation.
