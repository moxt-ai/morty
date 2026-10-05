---
name: worker-debug
description: Debug retained or live Cloudflare Worker failures for Morty staging or production. Use when a user asks to inspect deployed Worker logs, investigate an online API error, correlate a browser request with Worker execution, or compare staging and production behavior.
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Worker Debugging

Investigate a deployed Morty Worker from evidence to root cause. Prefer
retained Workers Observability events for failures that already happened;
`wrangler tail` only observes new events.

## Establish the target

Resolve the repository root with `git rev-parse --show-toplevel`, inspect
`wrangler.jsonc`, and inspect `git status --short` without changing user work.
Use only configuration read from this checkout:

| Environment | Worker | Origin |
| --- | --- | --- |
| staging | `morty-staging` | `https://morty.paradev.biz` |
| production | `morty-production` | `https://morty.build` |

Treat “online” as ambiguous. Infer the environment only from a supplied URL or
other concrete evidence; otherwise ask. Never default a destructive operation to
production. Log reads and bounded health requests are read-only, but still state
which environment is being inspected.

Record the narrowest available time window, including its timezone. Capture a
Cloudflare Ray ID, request ID, URL/path, HTTP status, user-visible error code, and
reproduction time when available. Convert times to Unix milliseconds explicitly;
do not silently assume UTC for a timestamp shown in local browser tools.

## Validate access and observability

Use the repository-pinned Wrangler. Run `pnpm exec wrangler whoami` and confirm
that its account matches `account_id` in `wrangler.jsonc`. Never print, paste,
commit, or return API/OAuth tokens.

Confirm the selected environment has Workers Observability and invocation logs
enabled. The root `observability` configuration is inherited unless the selected
environment overrides it. Distinguish these cases:

- Retained historical events: query Workers Observability.
- New reproduction: use a bounded `wrangler tail` session.
- Local `wrangler dev` output: not evidence of the deployed Worker.

If authentication lacks Workers Observability access, report the missing
capability. Do not claim that historical logs are unavailable merely because
`wrangler tail` cannot retrieve them.

## Query retained events

Use Cloudflare's official Workers Observability Telemetry API:

```text
POST /accounts/{account_id}/workers/observability/telemetry/query
```

Use an authenticated Cloudflare client or a private temporary script. Prefer the
dedicated `MOBIUS_CF_LOG_API_TOKEN`, then `CLOUDFLARE_API_TOKEN`. The token needs
**Account → Workers Observability → Edit** for the account in `wrangler.jsonc`;
the telemetry query API currently calls this permission Workers Observability
Write. Wrangler OAuth credentials do not include this permission by default, so
do not use one until a bounded API probe proves it is authorized.

Check only whether the selected environment variable is nonempty; never print its
value. If the user configured it in `.zshrc`, run the diagnostic process through
an interactive Zsh invocation so the process inherits it without copying the
secret into a command argument or repository file. Load the token inside the
process, send it only to `api.cloudflare.com` over HTTPS, and never place it in
source files, shell history, command output, or generated diagnostics. Delete
temporary scripts and raw responses after extracting sanitized evidence.

Start with an `events` query over a narrow window and filter by
`$metadata.service` equal to the exact Worker name. Add the strongest known
correlation filter: `$metadata.rayId`, `$metadata.requestId`,
`$metadata.statusCode`, `$metadata.url`, `$metadata.message`, or
`$metadata.error`. Use `cloudflare-workers` as the dataset, a result limit no
larger than 100, and `dry: true`. Example body shape:

```json
{
  "queryId": "worker-debug-adhoc",
  "timeframe": { "from": 0, "to": 0 },
  "view": "events",
  "dry": true,
  "limit": 100,
  "parameters": {
    "datasets": ["cloudflare-workers"],
    "filterCombination": "and",
    "filters": [
      {
        "key": "$metadata.service",
        "operation": "eq",
        "type": "string",
        "value": "morty-staging"
      }
    ]
  }
}
```

Replace both timestamps and the Worker name; the zero values are deliberately not
runnable defaults. If field names or types are uncertain, discover them through
`POST /accounts/{account_id}/workers/observability/telemetry/keys` and unique
values through `/values` before querying. Do not broaden beyond 24 hours without
explaining why. Paginate using the last event's `$metadata.id` only when needed.

Once one event is identified, query the same request ID with the `invocations`
view to collect all logs from that invocation. Follow trace IDs across services
when the failure crosses Chat and Platform Workers. Preserve timestamps, service,
script version, status, request/Ray/trace IDs, message, error type, and stack
location. Do not retain request bodies, credentials, cookies, authorization
headers, pairing tickets, transfer codes, or user content.

## Reproduce with live tail

When retained evidence has no match and reproduction is safe, start a bounded
tail against the explicit environment:

```sh
pnpm exec wrangler tail --env staging --format json
```

Use `--env production` only after the target is confirmed. Apply supported
status, method, header, or search filters to reduce unrelated traffic. Start the
tail before one reproduction, stop it immediately afterward, and never ask a user
to repeat a destructive or privacy-sensitive action merely to create logs.

## Diagnose across boundaries

Map the observed route to the Worker handler and validation schema. For a generic
`INVALID_REQUEST`, inspect the logged typed error or validation issues rather than
guessing from the sanitized response. Compare all deployed boundaries involved:

1. Browser request construction and serialized byte size.
2. Chat Worker's global body limit, route body limit, and schema.
3. Platform gateway request construction.
4. Platform Worker's body parser and schema.
5. Runtime or agent protocol validation.

Check the deployed script version against Git history and submodule revisions.
Do not assume the current checkout was deployed at the failure time. Distinguish
an already-fixed deployment mismatch from a defect still present on current
`main`.

### Read deployed D1 or Durable Object data

When retained telemetry cannot reveal the persisted value needed to diagnose a
staging or production failure, deploy a separate, short-lived, token-gated
Worker in the same account and bind the target deployment's D1 database or
Durable Object class with `script_name`. Query only the records required for the
diagnosis through an existing internal read boundary, then delete the helper on
success or failure.

Do not upload diagnostic code as a version of the application Worker, alter its
active deployment, copy an encrypted application secret, weaken an authorization
gate, or run a migration merely to read data. State the exact staging or
production target before deploying the helper, keep its token in a mode `0600`
file, never print it, and independently verify that the helper was deleted.

## Implement and verify a fix

Before production changes, state the user-visible slice and add the repository's
required failing Given-When-Then acceptance scenario at the first supported
boundary. Preserve typed error codes and sanitized client messages; enrich local
structured logs with safe schema issue paths when generic validation responses
otherwise hide the cause.

Run only relevant tests, then `pnpm lint` and `pnpm typecheck`. Never run
`pnpm ci:check` locally. Do not deploy unless the user explicitly asks.

## Report findings

Return:

1. Environment, Worker, UTC time window, and correlation identifier.
2. Observed failure and the exact boundary that rejected the request.
3. Root cause, with deployed version versus current code called out.
4. Fix and verification performed, or the next missing piece of evidence.

Redact secrets and personal/user content. It is acceptable to report that no
matching retained event was found; it is not acceptable to state that previous
logs cannot be analyzed without first checking Workers Observability.
