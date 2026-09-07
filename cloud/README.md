# Cloud

`cloud` is the closed-source web entry point for Mobius Cloud. It is developed
in this repository rather than as a separate Git submodule.

## Workspaces

A workspace is a Clerk Organization. Clerk owns its ID, name, memberships,
creation permissions, and deletion permissions; there is no duplicate workspace
or membership database in Cloud.

After signing in, users can:

- View a paginated list of the workspaces they belong to.
- Create a workspace by entering a name.
- Open `/workspaces/<organization-id>` to select that workspace and see a blank
  TODO page. Direct links and browser navigation are supported.
- Delete a workspace when they have permission, after confirming the deletion.

The React app uses Clerk's authenticated Organization APIs. Listing is scoped
to the signed-in user's memberships. Opening sets the active Organization;
Clerk verifies membership. Deletion is enforced by Clerk even if permissions
change after the list was loaded. Removing a workspace deletes its Organization
and memberships, not merely the current user's membership.

Clerk Organizations must be enabled in each instance, with membership optional
(`force_organization_selection: false`) so a user can reach the empty list before
creating their first workspace. Allow user-created Organizations and admin
deletion. No Clerk secret key is required in the deployed app.

Each operation has a deadline and stops updating the page after navigation or
sign-out. Clerk's browser SDK does not expose request cancellation: a timed-out
mutation may still complete remotely. Mutations are never automatically retried;
refresh the list to reconcile an uncertain result.

## Future integrations

The workspace TODO page is intentionally blank. Mobius agents and chat history,
Mobius Slack connections, and additional applications will be integrated here.
No agent, chat, Slack, or task data is provisioned by this slice.

Cloud owns the physical D1 inventory in [configuration](../infra/d1-shards.json).
It has no database bindings or application database. Business services will share
regional shards while owning their tables and migration histories independently.
Workspace placement is planned in Clerk Organization private metadata. The
[storage contract](../docs/storage.md) records the created empty shards, current
service databases, and remaining integration work.

When service provisioning is implemented, workspace deletion must coordinate
cleanup in those services before removing the Organization. Today there are no
linked service resources to delete.

Private deployments have one fixed workspace and do not require the hosted
workspace selection or node placement UI.
