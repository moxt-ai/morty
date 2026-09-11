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
  `/SKILL.md`, for example `https://mobius.paradev.biz`. Use that same environment
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

Expect `201` and a JSON object with `token` and `userId`. Validate the returned
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

## 2. Install and inspect the Mobius CLI

Use Node.js 22.13.0 or newer. If Mobius is already installed, inspect its version
and help before changing it. Otherwise install the published CLI:

```sh
npm install -g @moxt-ai/mobius
mobius --version
mobius --help
mobius agents --json
```

Inspect the reported agent inventory. Choose an available, integration-ready
agent with the user and complete that agent's own installation/authentication if
needed. A successful CLI installation alone does not prove an agent can reply.

## 3. Provision, pair, and configure

Resolve the anonymous user's Cloud-owned Project and authorize all setup operations
with their `user_token`. Read it with `GET /mobius-cloud/api/management/project`.
If `project` is `null`, use `POST /mobius-cloud/api/management/project` with JSON
`{ "displayName": "My Project" }` and the same Bearer token. Both operations return
`{ "project": { "projectId": "...", "displayName": "..." } }` once configured.
Chat uses its AppCredential with Platform; the agent never needs it. Chat supplies
a logical location hint, and Platform resolves its own D1 and R2 resources.
Reuse saved resources when they are still valid. Obtain a Project-scoped Runtime
pairing from Chat:

```http
POST $BASE_URL/mobius-cloud/api/management/runtime-pairings
Authorization: Bearer <user_token>
Content-Type: application/json

{ "idempotencyKey": "<stable key for this pairing attempt>" }
```

Expect `201` with `relayUrl`, `pairingId`, `pairingCode`, `runtimeId`, `projectId`,
`channelId`, `pollToken`, and `expiresAt`. Save the pairing attempt key before the
request and reuse it on retries. Use a new key only for a new pairing attempt.
Do not send a Project ID: Chat resolves ownership from the user token. A
`PROJECT_REQUIRED` response means you must create the user's Project first.

Use the returned Platform relay origin, Runtime pairing ID, and pairing code:

```sh
mobius pair --url "$RELAY_URL" --pairing "$RUNTIME_PAIRING_ID" --code "$PAIRING_CODE" --workspace "$WORKSPACE_DIR"
```

Pass arguments separately and quote paths. Never substitute the Cloud user ID,
Bot ID, or a legacy channel pairing ID for a Runtime pairing ID. Never give the
local CLI the user's Cloud token as its pairing code or an AppCredential.

`mobius pair` saves the Runtime connection and starts its long-running daemon.
Run it in a persistent terminal or an explicitly managed background process;
keep it alive while the user chats. For an existing saved connection, the current
CLI resumes it with `mobius start --channel <saved-channel-id>`. Use the saved ID
reported by the CLI rather than inventing one.

Read pairing completion with
`GET /mobius-cloud/api/management/runtime-pairings/<pairingId>` using the same
Bearer token. The response has `status: "pending"`, `"paired"`, `"expired"`, or
`"revoked"`; paired responses include the Runtime and its discovered agent inventory.
Use bounded, cancellable waits until the pairing expiry; stop on expiry or revocation.

After pairing, confirm through Cloud that the Runtime is online. Create or reuse
a Bot owned by this anonymous user, select the available agent and workspace,
configure its behavior and execution binding, and complete any Runtime approval
required by that binding. Confirm the Bot is ready. Save returned resource IDs
alongside the identity so a later setup can resume them.

### Current implementation status

The identity, Project, Runtime pairing, and handoff endpoints in this skill exist in source.
Deploy the matching AppCredential-enabled Platform version before using anonymous
Project creation. Bot setup and conversation access are still being migrated:

- Bot claims still use a legacy access-token API.

These are not supported anonymous setup alternatives. Until Cloud provides the
anonymous Bot setup contract, stop this step and report the missing capability. Do
not invent endpoints, ask the user to sign in as a workaround, acquire an
AppCredential, or claim a working chat connection. Preserve the anonymous token
so setup can resume after the migration. The pairing command above is the
verified CLI contract; it still requires a real pairing issued by the service.

## 4. Verify the main journey

Before calling setup complete, verify that the Bot can receive a message and
return an agent response, and that reopening the conversation retains history.
Use `agent-browser` CLI in a named session when browser automation is available.
Exercise the real Cloud endpoints and Runtime, not intercepted responses. Record
the actual result and any blocker. Keep tokens and handoff links out of screenshots.

Browser automation must use its own identity transfer. Never open, preview, or
redeem the final handoff link intended for the user: redemption consumes it.

## 5. Generate the user's one-time browser URL last

Once setup and verification succeed, request a fresh transfer using the saved
anonymous token:

```http
POST $BASE_URL/mobius-cloud/api/identity/transfers
Authorization: Bearer <user_token>
```

Expect `201` with `url` and `expiresAt`. Check that the URL has the same origin
as `BASE_URL`, its path is `/continue`, and its fragment contains `code`. Return
the exact URL from the server to the user, along with the expiry. Do not construct
a link containing `user_token`. Do not cache the transfer as the durable identity.

When the user opens this link, the application redeems the code via
`POST /mobius-cloud/api/identity/transfers/redeem` with JSON `{ "code": "..." }`,
stores a browser credential for the same anonymous user, and opens their workspace.
The agent's saved token remains usable. Transfers are one-use and expire; `410`
means the link expired or was consumed. Generate a new transfer with the original
saved token instead of creating a new anonymous user.

Tell the user which Bot is ready, where the Runtime is running, that the Runtime
must stay online, and: **Open this one-time link to chat. You can bind an account
later if you want.** Only say the Bot is ready after actually verifying it.
