# Mobius Cloud

Mobius Cloud is the hosted, multi-workspace distribution of Mobius. It is built
from independent services that share identity and workspace boundaries. Cloud
owns physical D1 shards; each business owns its tables and migrations within
those shards. Services communicate through their APIs. The same service model also supports private deployments.

## Repository layout

- [`mobius`](mobius/) connects and operates agents, provides agent identity, and
  delivers system prompt contributions.
- [`apps/slack`](apps/slack/) connects workspaces and agents to Slack.
- [`apps/workflow`](apps/workflow/) coordinates Tasks across humans and agents,
  with optional scheduling and proactive supervision.
- [`cloud`](cloud/) is the closed-source web and workspace control plane for the
  hosted service.
- Future `app-*` services add more web-based capabilities for agents and humans.

Mobius and public applications are included as Git submodules. `cloud` is
developed directly in this monorepo because it is not an open-source service.

## Development

The root project builds and deploys the `cloud` Worker. The Git submodules are
independent projects with their own dependencies and checks.

Requires Node.js 24.20.0 and pnpm 11.25.0.

```bash
pnpm install
pnpm dev
pnpm check
```

The web app uses React 19, TypeScript, Vite, and Tailwind CSS 4. Clerk provides
sign-up, sign-in, profile management, and sign-out. The Worker verifies signed
session tokens locally before returning the current account. Authentication
state is owned by Clerk. React Router loaders and actions manage workspace data;
Zustand stores dialog state. Cloud has no application database. Its physical
D1 inventory lives in [configuration](infra/d1-shards.json); business services
will use those shards through the [storage contract](docs/storage.md).

Copy `.dev.vars.example` to `.dev.vars` and fill in your Clerk configuration
before running the app at `http://localhost:5173`. See
[DEVELOPMENT.md](DEVELOPMENT.md) for configuration and deployment, and
[TESTING.md](TESTING.md) for testing requirements. Signed-in users can list,
create, delete, and open their workspaces. Each workspace opens a blank TODO page. Node placement and the remaining service
integrations described below are planned behavior.

## Workspaces

A workspace is a Clerk Organization. Its ID is the Clerk Organization ID, and
Clerk owns its membership and permissions. It is the business and operational
isolation boundary for multiple human users and, in future integrations, agents.

Human identities come from [Clerk](https://clerk.com/). Agent identities come
from Mobius.
Each application owns the authorization rules for its own operations. Identity
answers who is calling; the application decides what that caller may do inside
the workspace.

Cross-workspace access is not allowed.

## Cloud control plane

The hosted `cloud` service provides the web entry point for human users. It lets
them:

- View workspaces they can access.
- Create workspaces and delete workspaces they have permission to manage.
- Open a workspace at `/workspaces/<organization-id>` and see its blank TODO page.

In the planned service integration, `cloud` will know available nodes and decide
which node should serve a newly created workspace. After a human selects a workspace, the browser is redirected to the
workspace's URL. Normal application traffic then goes directly to that node and
does not pass through `cloud`.

```text
Human ──> cloud ──> create workspace and select node
          │
          └── select workspace
                  │
                  └── redirect to workspace URL ──> assigned node
```

## Nodes

Nodes are deployed in multiple locations around the world. One node can serve
multiple workspaces and can run Mobius, `app-slack`, `app-workflow`, and other
`app-*` services.

```text
Regional shard managed by Cloud
├── Mobius tables and mobius_migrations
├── Slack tables and slack_migrations
└── Other applications' tables and migration histories
```

A node is a deployment grouping. A physical D1 shard can hold tables from several
businesses and data from several workspaces. Each service owns its tables,
migration files, and authorization. Sharing the database does not authorize a
service to access another business's tables or bypass workspace checks.

Cloud keeps the database inventory in a configuration file. The planned stable
workspace-to-shard assignment lives in Clerk Organization private metadata;
Cloud does not need a database of its own. See [storage](docs/storage.md) for
regional placement, schema migrations, capacity, and current deployment status.

Workspaces normally stay on the node where they were provisioned. This supports
local access and limits a node failure to the workspaces served by that node.

## Request path

There is no central workspace router in the normal request path. Clients learn the
correct endpoint during workspace or integration provisioning:

- Human browsers are redirected by `cloud` to the workspace URL.
- Mobius daemons connect directly to their assigned node.
- Agents call application URLs disclosed through their system prompt.
- Slack is configured with the `app-slack` endpoint for the workspace's node.

Each service verifies the caller and checks its own tables for the workspace. If
a request reaches the wrong node, the service returns `WORKSPACE_NOT_SERVED`. It
does not ask `cloud` to locate another node, forward the request, or migrate the
workspace.

## Identity and authorization

The platform has three common caller types:

- A human presents a signed Clerk session token.
- An agent presents a short-lived opaque identity credential issued by Mobius.
- An external platform, such as Slack, presents proof defined by its protocol.

Receiving services verify signed human credentials locally. Application
services introspect opaque Agent credentials with Mobius on every request. The
service credential used for introspection determines the token audience; an
application cannot select another audience in its request.

A valid credential proves identity, not permission. Each application implements
authorization for its own resources and actions. For example, `app-slack`
verifies that a request came from Slack and then separately checks whether the
human or agent represented by the Slack event may perform the requested action.

## Progressive application discovery

Applications expose web services rather than installing local agent tools or
placing complete API schemas into every agent context.

An application registers a small system prompt contribution with Mobius. The
contribution tells an agent:

- That the application service exists.
- Where the service and its detailed API documentation are located.
- That the agent should use a Mobius-issued identity token when calling it.

Mobius delivers the registered contribution as part of the agent's system
prompt. The agent decides whether the capability is relevant. Only when needed
does it read the detailed API documentation and call the service with an HTTP
client such as `curl`.

```text
Application
  └── register short prompt contribution
          │
          ▼
        Mobius ── inject into system prompt ──> Agent
                                                   │
                                                   ├── read API when needed
                                                   ├── obtain agent identity token
                                                   └── call application directly
```

This keeps the default context small while still allowing an agent to discover
and use many services.

System prompt registration is generic. Mobius stores and delivers the registered
content without knowing whether it describes Slack or another application.
Mobius does not call application APIs, contain their SDKs, or depend on any
specific `app-*` service.

The dependency points in the other direction: an application registers its
prompt contribution with Mobius, hosts its own API documentation, verifies the
Mobius-issued agent token, and performs its own authorization.

## State ownership

Clerk owns human accounts, login providers, sessions, workspaces (Organizations),
and workspace membership. Every Mobius Cloud
service owns its persistent and temporary state:

| Service | State owned by the service |
| --- | --- |
| `cloud` | Workspace UI, physical D1 inventory in configuration; planned placement in Clerk metadata |
| `mobius` | Served workspaces, agents, daemon registrations, agent identity, and prompt contributions |
| `app-slack` | Served workspaces, Slack installations, identity bindings, authorization, and conversation mappings |
| `app-workflow` | Served workspaces, workflows, work items, schedules, execution history, and supervision state |
| `app-*` | Served workspaces and application-specific business data |

A physical D1 shard is shared infrastructure. Each service independently owns
its business data and migrations; there are no cross-business table dependencies.
Cloud manages shard inventory through configuration and planned placement through
Clerk metadata. Caches, queues, event deduplication, and online presence remain
owned by the business that uses them.

## Private deployment

A private deployment has exactly one workspace and does not include the hosted
`cloud` service. It does not offer workspace creation, workspace selection, or node
placement.

The fixed workspace is still represented in credentials, databases, and
authorization checks so that cloud and private deployments use the same service
model.

Human login uses Clerk. Enterprise deployments may connect their identity
provider through Clerk's SAML or OIDC support. Mobius, `app-slack`,
`app-workflow`, and other applications run against the private deployment's
local services and databases.

## Applications

Applications add user-facing capabilities without expanding Mobius itself:

- [`app-slack`](apps/slack/) lets humans talk to agents in Slack and lets agents
  read or send Slack messages using their own identity.
- [`app-workflow`](apps/workflow/) coordinates Tasks across humans and agents,
  and can schedule agents to monitor, react, and keep work moving.

Applications expose their capabilities to agents through Mobius system prompt
contributions. They own their business state and authorization, remain
independent from one another, and are not dependencies of Mobius. See each
application's README for its detailed product and architecture specification.
