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
The only hosted application environment is production in the Morty Cloudflare
account. Development, integration and performance checks use isolated local or
CI services; there is no permanent staging or benchmark deployment. Local
services must not use production credentials or silently fall back to production.
Moxt resources, credentials, local state and release channels remain independent.

## Cloud deployment

The Morty Cloud workflow builds a checksummed portable artifact, validates its
source revision and pinned destination, then archives it. Pull requests build
without deployment secrets. Deployment runs only from main with explicit dispatch
or the configured production auto-deploy switch.

The `morty-production` deployment environment supplies `CLOUDFLARE_API_TOKEN` and
`MORTY_SERVICE_SECRET` individually. The latter authenticates Morty's internal
service and is stored only as a digest in the relay database. Runtime secret
values are assembled in a private short-lived file and removed after deployment.

Use a Cloudflare Account API Token for CI/CD so deployment authority belongs to
the Morty account independently of its creator's user membership. Limit it to the
account's required Workers, D1 and R2 write permissions and set an expiration.
Deployment, restore and service provisioning verify account ownership and active
status before making changes. Rotate the environment secret before expiry and
verify a deployment before revoking the replaced token; never use a personal
User API Token or a Global API key as a fallback.
Never log credentials.

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

npm public provenance is available only for public source repositories. While this
repository is private, OIDC still binds publishing authority to the configured
workflow and environment, and the archived release records its source revision and
checksums. Do not describe that release record as a public provenance attestation.

Keep the previous production setup available until the new package is published
and its replacement verified. The authorized pre-launch reset supports only the
current Morty protocol and installation generation. Activate the matching cloud
and CLI release together, then verify fresh installation, pairing, conversation,
attachments and reconnect. Earlier Morty credentials, local state and browser
links are unsupported; no legacy reader or forwarding service is required.

Release 0.3.0 completes this reset by rejecting retired Morty messages and saved
formats instead of filling missing fields, converting old pairings, or rebuilding
old projections. Retained production records remain untouched. Use fresh
installation and pairing for the current release; do not assume a preserved
historical record can be read by the launch services.

Preserve release archives and retained data for recovery. Do not roll a new
installation back into an earlier state generation or replay old writers against
new schemas. Recovery restores an accepted matching cloud/CLI release and uses
fresh pairing when generations differ. Moxt services and Agent-owned data remain
outside this cutover. Subsequent releases follow the normal compatibility policy.
