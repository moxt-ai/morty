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

The release pipeline builds the checksummed portable cloud artifact together with
the CLI archive, validates its source revision and pinned destination, then
archives it. Pull requests build without deployment secrets. Ordinary production
publication is owned by the Morty CLI workflow after a merge to main; a separate
cloud workflow must never automatically deploy a competing build. The Morty Cloud
workflow only runs manual cloud operations: service credential provisioning and
recovery of an accepted archived release.

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
Morty npm version exists with the accepted archive integrity. Upload assets and setup before changing the Worker.
A restore uses the archived bytes and source revision, validates current Durable
Object migration history, and never rolls persistent data backwards.

Wrangler updates supplied secrets additively. Remove retired Clerk/OIDC/webhook
secrets explicitly only after replacing their consumers and verifying the target
service. Cloudflare cannot return stored secret plaintext; obtain it from its
owner or rotate the environment's service credential through storage operations.

## Automatic release sequence

Build each release once. The merge queue runs the complete source validation,
security scan and browser acceptance on the exact commit that main becomes. It
assigns that commit's stable patch version, builds one CLI archive and its matching
cloud artifact, and tests the archive on every supported OS/Node combination. Pull
requests exercise the same gates without publication credentials, testing the
archive on Linux across the supported Node versions; the merge queue adds macOS
and Windows before anything reaches main.

Release only the newest main commit, and only when it changes something other than
Markdown since the production release. An older commit's changes ship with the
newest one instead of queueing a release of their own, and a Markdown-only change
publishes nothing. The release workflow publishes the archive the merge queue
accepted instead of rebuilding and retesting the same source; a commit without an
accepted archive is built and validated by the release workflow before
publication.

Expose a release only after production verified it. The release deploys the cloud
Workers first and verifies production health, assets and Session access. If any
check fails, it restores the Workers to the versions that served before the
release and stops, leaving npm `latest` and the hosted setup unchanged. Only a
verified cloud deployment allows npm publication, which moves `latest`. The hosted
setup installs `latest`, so it is replaced only after the registry serves the
accepted archive. Only the completed chain allows creation of the source tag and
GitHub Release. Until publication completes, the new Workers serve the previous
CLI and setup, which the compatibility contract already requires. Database
migrations are applied before the Workers and are never reversed, so a migration
must remain compatible with the Workers a failed release restores.

Release versions are derived from a committed stable-version baseline and the
number of first-parent main commits since its recorded source revision. The same
commit therefore always selects the same version, including after a failed run.
The package manifest in source records the baseline; release builds apply the
computed version without a bot commit or protected-branch bypass. Failed or
non-published commits can leave patch-number gaps. Minor/major changes require a
reviewed baseline update, and do not authorize protocol incompatibility.

Production runs queue serially, including manual recovery. An older release must
not overwrite a newer published version. Preserve the immutable CLI and cloud
artifacts from the original run: retry failed jobs on that run, rather than
rebuilding published bytes. Missing, expired or inconsistent artifacts stop the
release. The workflow never silently replaces a published npm version or moves a
release tag. Build and deployment records bind version, source revision and
archive integrity; GitHub Release assets retain the accepted artifacts beyond
Actions artifact retention.

Every failed gate stops dependent stages. When the automatic Worker restoration
itself fails, the job reports it and production keeps the unverified Workers until
recovery; npm and the hosted setup remain unchanged. npm and Cloudflare are
independent systems, so a failure after npm publication cannot undo publication;
it leaves an incomplete release with no final GitHub Release. Inspect the failing
job, correct the operational cause, and rerun failed jobs with the original
artifacts. Do not unpublish or repack that version. If code changes are necessary,
merge a correction and release a newer version. Cloud deployment can partially
complete before a failure; use the recorded component versions and migration
checks for recovery, never reverse database migrations automatically.

Manual recovery accepts only an archived main-branch run that completed the full
publication/deployment chain, or a legacy cloud archive with a successful CLI
publication for the same source revision. It uses
that run's exact cloud artifact and independently verifies the published CLI
integrity. Recovery intentionally changes the deployed version; it does not
republish npm or rewrite the existing GitHub Release. Release automation and
recovery share a production lock.

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
