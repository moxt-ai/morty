---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Morty releases and deployment

Morty owns one workspace and one public npm distribution, `@morty-build/cli`.
Internal client, Runtime, relay, and storage code is not separately published.
The only hosted application environment is production in the Morty Cloudflare
account. Development, integration and performance checks use isolated local or
CI services; there is no permanent staging or benchmark deployment. Local
services must not use production credentials or silently fall back to production.
Moxt resources, credentials, local state and release channels remain independent.

## Cloud deployment

Production is one `morty-production` Worker at `morty.build`. It serves the website,
identity and computer management APIs, pairing and Session traffic. Each computer
owns its state and Runtime connection in a `ComputerRelay` Durable Object. Relay
is an internal responsibility of this deployment, not a separately deployed
service. D1 holds the computer directory; R2 holds immutable web assets.
Conversation attachments remain on the connected computer. Local and CI stacks
use the same topology with isolated storage.

The release pipeline builds the checksummed portable cloud artifact together with
the CLI archive, validates its source revision and pinned destination, then
archives it. Pull requests build without deployment secrets. Ordinary production
publication is owned by the Morty CLI workflow after a merge to main; a separate
cloud workflow must never automatically deploy a competing build. The Morty Cloud
workflow only recovers an accepted archived release.

The `morty-production` deployment environment supplies `CLOUDFLARE_API_TOKEN` and
`MORTY_SESSION_SIGNING_SECRET` individually. The signing secret authorizes short-lived
Session credentials and never enters browser code or stored account records.
Internal calls need no separate service credential. Secret values are assembled
in a private short-lived file and removed after deployment.

Use a Cloudflare Account API Token for CI/CD so deployment authority belongs to
the Morty account independently of its creator's user membership. Limit it to the
account's required Workers, D1 and R2 write permissions and set an expiration.
Deployment and restore verify account ownership and active
status before making changes. Rotate the environment secret before expiry and
verify a deployment before revoking the replaced token; never use a personal
User API Token or a Global API key as a fallback.
Never log credentials.

Morty's identity, sharing, pairing and authorization remain enforced. Preserve
computer and Agent data, release archives, and immutable database migration history.

Deployment checks account authority, artifact identity, required secrets and the
destination resources before writes. Production refuses to activate an installer until the exact
Morty npm version exists with the accepted archive integrity. Upload immutable assets before changing the Worker.
A restore uses the archived bytes and source revision, validates current Durable
Object migration history, and never rolls persistent data backwards.

Cloudflare cannot return stored secret plaintext; obtain it from its
owner or replace it with a new signing secret. Rotating the signing secret ends
existing Session access; Runtime and owner credentials have separate lifetimes.

## Automatic release sequence

Build each release once. The merge queue runs the complete source validation,
security scan and browser acceptance on the exact commit that main becomes. It
assigns that commit's stable patch version, builds one CLI archive and its matching
cloud artifact, and tests the archive on every supported OS/Node combination. Pull
requests exercise the same gates without publication credentials, testing the
archive on Linux across the supported Node versions; the merge queue adds macOS
and Windows before anything reaches main.

Release only the newest main commit, and only when it changes something that ships
since the production release. Documentation, repository automation and tests never
reach a release artifact, so a change confined to them publishes nothing. An older
commit's changes ship with the newest one instead of queueing a release of their
own. The release workflow publishes the archive the merge queue
accepted instead of rebuilding and retesting the same source; a commit without an
accepted archive is built and validated by the release workflow before
publication.

The sequence is production preflight, npm publication and integrity verification,
cloud deployment and verification, then source tag and GitHub Release. Publication
must pass the exact-archive acceptance gates first. Keep the existing installer
available until the accepted npm archive exists; then activate the matching cloud
artifact and verify health, assets, pairing and Session access.

D1 migrations run before Worker activation and are never reversed. For ordinary
updates, a failed deployment restores the previous Worker only when Durable
Object lifecycle history permits it. Creation or deletion of a DO namespace
requires forward repair; do not claim an ordinary version rollback restored it.
A failure after npm publication leaves an incomplete release: npm publication
cannot be undone by restoring a Worker.

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
itself fails, the job reports it and production keeps the unverified Worker until
recovery. npm and Cloudflare are
independent systems, so a failure after npm publication cannot undo publication;
it leaves an incomplete release with no final GitHub Release. Inspect the failing
job, correct the operational cause, and rerun failed jobs with the original
artifacts. Do not unpublish or repack that version. If code changes are necessary,
merge a correction and release a newer version. Cloud deployment can partially
complete before a failure; use the recorded component versions and migration
checks for recovery, never reverse database migrations automatically.

Manual recovery accepts only an archived main-branch run that completed the full
publication/deployment chain and contains the consolidated single-Worker format. It uses
that run's exact cloud artifact and independently verifies the published CLI
integrity. Recovery intentionally changes the deployed version; it does not
republish npm or rewrite the existing GitHub Release. Release automation and
recovery share a production lock.

## CLI publication

Build and pack once, then test that same archive across supported systems and
Node versions, including coexistence with a real released Moxt installation.
Record its source revision and integrity. Publication requires the complete
acceptance gates for that exact archive.

The Morty CLI workflow publishes only from main after its checks pass and the
complete product acceptance and review are finished. Configure npm Trusted
Publishing for this repository, `morty-cli.yml`, and the `morty-npm` environment.
Verify registry integrity after publication.

npm public provenance is available only for public source repositories. While this
repository is private, OIDC still binds publishing authority to the configured
workflow and environment, and the archived release records its source revision and
checksums. Do not describe that release record as a public provenance attestation.

Activate matching cloud and CLI artifacts and verify installation, pairing,
conversation, attachments and reconnection. Recovery restores an accepted matching
release without reversing persistent migrations. Keep Moxt services and Agent-owned
data independent of Morty release and recovery operations.
