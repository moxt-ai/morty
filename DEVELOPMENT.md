# Development

Behavior is defined by production code and executable scenarios. This guide links
those owners instead of maintaining a second description of their state machines.
See [AGENTS.md](AGENTS.md) for engineering rules and [TESTING.md](TESTING.md) for verification.

## Implementation map

| Concern | Implementation | Executable scenarios |
| --- | --- | --- |
| Worker entry and routing | [Worker](packages/worker/src/index.ts), [composition](packages/worker/src/composition/) | [Worker tests](packages/worker/tests/) |
| Identity, Bot ownership and pairing | [management](packages/worker/src/components/management/) | [identity](packages/worker/tests/identity.integration.test.ts), [chat creation](packages/worker/tests/chat-creation.integration.test.ts) |
| Project persistence | [Project DO](packages/worker/src/components/project/project-durable-object.ts), [schema](packages/worker/src/schema/project-do/), [migrations](packages/worker/migrations/project-do/) | [Worker tests](packages/worker/tests/) |
| Browser persistence | [registered storage](packages/web/src/services/local-storage/central-local-storage.ts) | [Web tests](packages/web/tests/) |
| Live messages, history and delivery | [session pane](packages/web/src/view-models/chat/session-pane-store.ts), [presentation](packages/web/src/view-models/chat/session-presentation.ts), [delivery](packages/web/src/view-models/chat/session-delivery-store.ts) | [active conversation](packages/web/tests/conversation-active.integration.test.tsx), [queue](packages/web/tests/conversation-queue.integration.test.tsx), [browser journey](packages/e2e/conversation.e2e.test.ts) |
| Setup instructions and executable | [templates](templates/), [setup](packages/setup/src/setup.ts) | [instruction documents](packages/worker/tests/instruction-documents.integration.test.ts), [setup journey](packages/e2e/setup.e2e.test.ts) |
| Layer dependencies | [architecture rules](dependency-cruiser.config.cjs) | `pnpm check:architecture` |

## Local development

Use [the local-stack skill](.agents/skills/chat-local-full-dev/SKILL.md) for isolated
Chat and Platform startup and cleanup. Protocol and SDK workspace dependencies come
from the Mobius submodule; sync it before repository work.

## Build and artifact operations

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
pnpm exec wrangler r2 bucket domain add morty-production-web-assets --domain assets.morty.build --zone-id <MORTY_BUILD_ZONE_ID> --min-tls 1.2 --force
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
Runtime and clock ports. The CLI supplies the local manager implementation. Setup
persists identity and Bot configuration but not App, Runtime, Connection, Channel, or
pairing identifiers.

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
