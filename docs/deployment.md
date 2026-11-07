---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Morty releases and deployment

Morty owns one workspace and one public npm distribution, `@morty-build/cli`.
Internal client, Runtime, relay, and storage packages are not separately published.
Production and benchmark have separate service identities, credentials, and
Cloudflare resources. Moxt credentials and release channels must not be used.

## Cloud deployment

The Morty Cloud workflow builds a checksummed portable artifact, validates its
source revision and pinned destination, then archives it. Pull requests build
without deployment secrets. Deployment runs only from main with explicit dispatch
or the configured production auto-deploy switch.

Each deployment environment supplies `CLOUDFLARE_API_TOKEN` and
`MORTY_SERVICE_SECRET` individually. The latter authenticates Morty's internal
service, is stored only as a digest in the relay database, and must differ between
production and benchmark. Runtime secret values are assembled in a private
short-lived file and removed after deployment. Never log credentials.

Clerk, developer sign-in, organization management, and the generic platform
console are retired. Morty's anonymous identity, sharing, pairing and authorization
remain enforced. Removing unused authentication surfaces must not remove project
or Agent data. Historical database migrations are immutable.

Deployment checks the selected service credential against its destination before
writes. Production additionally refuses to activate an installer until the exact
Morty npm version exists. Upload assets and setup before changing the Worker.
A restore uses the archived bytes and source revision, validates current Durable
Object migration history, and never rolls persistent data backwards.

Wrangler updates supplied secrets additively. Remove retired Clerk/OIDC/webhook
secrets explicitly only after replacing their consumers and verifying the target
service. Cloudflare cannot return stored secret plaintext; obtain it from its
owner or rotate the environment's service credential through storage operations.

## CLI publication

Build and pack once, then test that same archive across supported systems and
Node versions, including coexistence with a real released Moxt installation.
Record its source revision and integrity. Do not publish a public prerelease to
bypass the acceptance gate in issue #6.

The Morty CLI workflow publishes only from main after its checks pass and the
complete product acceptance and review are finished. Configure npm Trusted
Publishing for this repository, `morty-cli.yml`, and the `morty-npm` environment.
First-publication authorization must be established separately; scope membership
alone does not configure a publisher. Verify registry integrity after publication.

Keep the previous production setup available until the new package is published
and its replacement verified. Existing Morty users reinstall and pair again;
there is no old-installation takeover or legacy forwarding fallback. Preserve
Moxt and Agent-owned data throughout the cutover.
