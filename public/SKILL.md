---
name: mobius-chat-setup
description: Set up Mobius Chat for a user with an anonymous identity, a local Mobius Runtime, and a one-time browser handoff. Clerk account binding is optional afterward.
---

# Set up Mobius Chat

You are helping a user connect a local AI agent to Mobius Chat. Complete the
setup on their machine, then give them a one-time URL that opens the same
anonymous identity in their browser. Do not require Clerk login or registration.
The user can optionally bind an account later.

## Inputs and local state

- `BASE_URL`: the Cloud origin from which this skill was fetched, without
  `/SKILL.md`, for example `https://mobius-chat.paradev.biz`. Use that same environment
  for identity creation, setup, and handoff. This is not the Platform relay URL.
- `DOCUMENT_DIR`: the user's document directory, resolved by your host environment.
  If it is unavailable, ask the user for it rather than guessing a repository path.
- `WORKSPACE_DIR`: the local project directory the user wants the agent to work in.
- Configuration: `$DOCUMENT_DIR/mobius-chat/config.json`.

Read the configuration first. It is a JSON object containing `user_token` when
the user already has an identity. Preserve other keys when updating it. Store
`base_url` alongside the token to identify its environment. If an existing
`base_url` differs from `BASE_URL`, stop and resolve the environment with the user;
do not replace their identity or send the token to a different service.

Keep the directory private (mode `0700`) and the config private (mode `0600`).
The durable `user_token` belongs in this file, not chat output, command arguments,
URLs, source control, screenshots, or logs. Never replace a valid existing token
just to retry a failed setup. Do not follow HTTP redirects with credentials.

## 1. Reuse or create the anonymous identity

If `user_token` exists, require a string matching
`^mobius_anon_v1_[A-Za-z0-9_-]{43}$` and verify it with:

```http
GET $BASE_URL/mobius-cloud/api/session
Authorization: Bearer <user_token>
```

A valid anonymous session returns `200` with `authentication.kind: "anonymous"`
and `userId`. Keep the token. A network failure or `503` does not mean the token
is invalid: retain it and report the temporary failure. If validation returns
`401`, report that the saved identity is unavailable before replacing it; creating
a different user does not recover the old user's Bots or conversations.

If the file or `user_token` is absent, create an identity:

```http
POST $BASE_URL/mobius-cloud/api/identity/anonymous-users
```

Expect `201` and a JSON object with `token`, `userId`, and `bot` containing
`botId` and `displayName`. Chat creates the user's Bot automatically during this
request. Validate the returned
token, then atomically save it as `user_token` before proceeding. Preserve any
existing configuration keys. Serialize concurrent setup attempts so they do not
overwrite each other's identities. If saving fails, stop and report the failure;
do not claim that the identity can be resumed locally.

The resulting config has this shape (placeholders only):

```json
{
  "base_url": "<BASE_URL>",
  "user_token": "<token returned by the anonymous-users endpoint>"
}
```

Use a JSON-aware HTTP client with a finite timeout and cancellation for each
request. Parse errors by `error.code`. A `404` means this deployment does not
expose the endpoint; do not treat an HTML application page as a successful JSON
response or fall back to Clerk registration.

## 2. Inspect the Mobius CLI

Use Node.js 22.13.0 or newer with npm. Run the latest published CLI through
`npx --yes`; no global Mobius installation is required:

```sh
npx --yes @moxt-ai/mobius@latest --version
npx --yes @moxt-ai/mobius@latest --help
npx --yes @moxt-ai/mobius@latest agents --json
```

Inspect the reported agent inventory. Choose an available, integration-ready
agent with the user and complete that agent's own installation/authentication if
needed. Successfully running the CLI alone does not prove an agent can reply.

## 3. Pair and configure the user's Bot

Authorize setup operations with `user_token`. Read the existing Bot with
`GET /mobius-cloud/api/management/bots`; do not ask the user to create or claim one.
The browser opens Chat directly. Storage placement and resource grouping are
internal to Chat and Platform and require no user configuration.
Obtain a Runtime pairing from Chat:

```http
POST $BASE_URL/mobius-cloud/api/management/runtime-pairings
Authorization: Bearer <user_token>
Content-Type: application/json

{ "idempotencyKey": "<stable key for this pairing attempt>" }
```

Expect `201` with `relayUrl`, `pairingId`, `pairingCode`, `runtimeId`, `projectId`,
`channelId`, `pollToken`, and `expiresAt`. Save the pairing attempt key before the
request and reuse it on retries. Use a new key only for a new pairing attempt.
Chat resolves ownership from the user token. If setup reports missing internal
resources, stop and report that failure rather than asking the user to provision them.

Use the returned Platform relay origin, Runtime pairing ID, and pairing code:

```sh
npx --yes @moxt-ai/mobius@latest pair --url "$RELAY_URL" --pairing "$RUNTIME_PAIRING_ID" --code "$PAIRING_CODE" --workspace "$WORKSPACE_DIR"
```

Pass arguments separately and quote paths. Never substitute the Cloud user ID,
Bot ID, or a legacy channel pairing ID for a Runtime pairing ID. Never give the
local CLI the user's Cloud token as its pairing code or an AppCredential.

The `pair` command saves the Runtime connection and starts its long-running daemon.
Run it in a persistent terminal or an explicitly managed background process;
keep it alive while the user chats. For an existing saved connection, the current
CLI resumes it with `npx --yes @moxt-ai/mobius@latest start --channel <saved-channel-id>`. Use the saved ID
reported by the CLI rather than inventing one.

Read pairing completion with
`GET /mobius-cloud/api/management/runtime-pairings/<pairingId>` using the same
Bearer token. The response has `status: "pending"`, `"paired"`, `"expired"`, or
`"revoked"`; paired responses include the Runtime and its discovered agent inventory.
Use bounded, cancellable waits until the pairing expiry; stop on expiry or revocation.

After pairing, confirm through Cloud that the Runtime is online. Reuse the Bot
created with the anonymous identity, select the available agent and workspace,
configure its behavior and execution binding, and complete any Runtime approval
required by that binding. Confirm the Bot is ready. Save returned resource IDs
alongside the identity so a later setup can resume them.

Request the execution binding through Chat using the discovered Runtime and agent:

```http
POST $BASE_URL/mobius-cloud/api/chat/bots/<botId>/setup
Authorization: Bearer <user_token>
Content-Type: application/json

{
  "runtimeId": "<paired Runtime ID>",
  "agentRef": "<agent ID reported by the paired Runtime>",
  "workspaceRef": "default",
  "agentConfigRevision": 1
}
```

`default` selects the workspace supplied to the `pair` command. Use the selected
agent's current configuration revision. Do not assume an agent installed on the
machine is advertised by this Runtime. A `202` response acknowledges the binding
request; it does not prove that local approval or message execution succeeded.
The local Runtime must authorize the binding before the Bot can chat.

Chat opens the conversation through its server-authorized `/access` endpoint.
The browser Mobius SDK then manages message submission, history, event streaming,
and short-lived conversation credential refresh. Keep the AppCredential on the
Chat server. If setup or conversation access fails, preserve the anonymous token
and report the actual failure rather than claiming the Bot is ready.

## 4. Generate the user's one-time browser URL last

Once setup succeeds, request a fresh transfer using the saved anonymous token:

```http
POST $BASE_URL/mobius-cloud/api/identity/transfers
Authorization: Bearer <user_token>
```

Expect `201` with `url` and `expiresAt`. Check that the URL has the same origin
as `BASE_URL`, its path is `/continue`, and its fragment contains `code`. Return
the exact URL from the server to the user, along with the expiry. Do not construct
a link containing `user_token`. Do not cache the transfer as the durable identity.
Never open, preview, or redeem the final handoff link: redemption consumes it.

When the user opens this link, the application redeems the code via
`POST /mobius-cloud/api/identity/transfers/redeem` with JSON `{ "code": "..." }`,
stores a browser credential for the same anonymous user, and opens their workspace.
The agent's saved token remains usable. Transfers are one-use and expire; `410`
means the link expired or was consumed. Generate a new transfer with the original
saved token instead of creating a new anonymous user.

Tell the user which Bot is ready, where the Runtime is running, that the Runtime
must stay online, and: **Open this one-time link to chat. You can bind an account
later if you want.** Only say the Bot is ready after its execution binding is approved.
