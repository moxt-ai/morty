import { RouterProvider } from "react-router/dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { WorkspaceDirectory } from "../../web/workspaces/contracts.ts";
import { createWorkspaceRouter } from "../../web/workspaces/router.tsx";
import {
  type ChatApplicationProps,
  type PairApplicationProps,
  type SlackApplicationProps,
  WorkspaceApplications,
} from "../../web/workspaces/WorkspaceApplications.tsx";
import { WorkspaceIdentityProvider } from "../support/workspace-directory.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
  window.history.replaceState(null, "", "/");
});
const routers: ReturnType<typeof createWorkspaceRouter>[] = [];
afterEach(() => {
  for (const router of routers.splice(0)) router.dispose();
  vi.useRealTimers();
});
async function renderWorkspaces(directory: WorkspaceDirectory) {
  const PairApplication = ({ onConnected }: PairApplicationProps<string>) => (
    <button type="button" onClick={() => onConnected("channel-1")}>
      Complete pairing
    </button>
  );
  const ChatApplication = ({ connection }: ChatApplicationProps<string>) => (
    <p>Chat is ready for {connection}.</p>
  );
  const SlackApplication = ({ connection }: SlackApplicationProps<string>) => (
    <p>Slack agent list is ready for {connection ?? "no channel"}.</p>
  );
  const WorkspaceManagement = () => (
    <WorkspaceApplications
      ChatApplication={ChatApplication}
      PairApplication={PairApplication}
      SlackApplication={SlackApplication}
    />
  );
  const router = createWorkspaceRouter(
    directory,
    async (signal) => {
      signal.throwIfAborted();
    },
    WorkspaceManagement,
  );
  routers.push(router);
  return render(<RouterProvider router={router} />);
}

test("Given a signed-in user, When they create and open a workspace, Then they see Pair, Chat, and Slack applications", async () => {
  const identity = new WorkspaceIdentityProvider();
  const screen = await renderWorkspaces(identity.forUser("alice"));
  await expect
    .element(screen.getByRole("heading", { name: "Workspaces", exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText("No workspaces yet")).toBeVisible();
  await screen.getByRole("button", { name: "New workspace" }).click();
  await screen.getByLabelText("Workspace name").fill("Research team");
  await screen
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await screen.getByRole("link", { name: "Research team" }).click();
  await expect.element(screen.getByRole("tab", { name: "Pair" })).toBeVisible();
  await expect
    .element(screen.getByRole("tab", { name: "Chat" }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("tab", { name: "Slack" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Complete pairing" }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Complete pairing" }).click();
  await expect
    .element(screen.getByRole("tab", { name: "Chat" }))
    .toHaveAttribute("aria-selected", "true");
  await expect
    .element(screen.getByText("Chat is ready for channel-1."))
    .toBeVisible();
  await screen.getByRole("tab", { name: "Slack" }).click();
  await expect
    .element(screen.getByText("Slack agent list is ready for channel-1."))
    .toBeVisible();
  await expect
    .element(screen.getByText("Research team", { exact: true }))
    .toBeVisible();
  await screen.getByRole("link", { name: "All workspaces" }).click();
  await screen.getByRole("button", { name: "Delete Research team" }).click();
  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect
    .element(screen.getByRole("link", { name: "Research team" }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Delete Research team" }).click();
  await screen
    .getByRole("button", { name: "Delete workspace", exact: true })
    .click();
  await expect.element(screen.getByText("No workspaces yet")).toBeVisible();
});

test("Given memberships in two workspaces, When a user views their list, Then only their workspaces appear and only their managed workspace can be deleted", async () => {
  const identity = new WorkspaceIdentityProvider();
  identity.create("Alice's team", "alice");
  const shared = identity.create("Shared team", "bob");
  identity.invite(shared, "alice");
  identity.create("Private team", "bob");
  const screen = await renderWorkspaces(identity.forUser("alice"));
  await expect
    .element(screen.getByRole("link", { name: "Alice's team" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Shared team" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Private team" }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Delete Alice's team" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Delete Shared team" }))
    .not.toBeInTheDocument();
});

test("Given a workspace URL belonging to another user, When it is opened directly, Then access is denied and the user can return to their workspaces", async () => {
  const identity = new WorkspaceIdentityProvider();
  const privateId = identity.create("Private team", "bob");
  window.history.replaceState(null, "", `/workspaces/${privateId}`);
  const screen = await renderWorkspaces(identity.forUser("alice"));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("no longer have access");
  await expect
    .element(screen.getByRole("tab", { name: "Slack" }))
    .not.toBeInTheDocument();
  await screen.getByRole("link", { name: "All workspaces" }).click();
  await expect.element(screen.getByText("No workspaces yet")).toBeVisible();
});

test("Given more than one page of memberships, When a user changes pages and opens a workspace, Then later workspaces remain accessible through their URL", async () => {
  const identity = new WorkspaceIdentityProvider();
  for (let i = 1; i <= 21; i += 1) identity.create(`Team ${i}`, "alice");
  const screen = await renderWorkspaces(identity.forUser("alice"));
  await screen.getByRole("link", { name: "Next", exact: true }).click();
  await expect
    .element(screen.getByRole("link", { name: "Team 21", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Team 1", exact: true }))
    .not.toBeInTheDocument();
  await screen.getByRole("link", { name: "Team 21", exact: true }).click();
  await expect
    .element(screen.getByRole("tab", { name: "Slack" }))
    .toBeVisible();
  const path = window.location.pathname;
  await screen.unmount();
  routers.at(-1)?.dispose();
  window.history.replaceState(null, "", path);
  const reopened = await renderWorkspaces(identity.forUser("alice"));
  await expect
    .element(reopened.getByText("Team 21", { exact: true }))
    .toBeVisible();
});

test("Given an unavailable identity provider, When connectivity returns and the user refreshes, Then the workspace list recovers", async () => {
  const identity = new WorkspaceIdentityProvider();
  identity.create("Research team", "alice");
  identity.disconnect();
  const screen = await renderWorkspaces(identity.forUser("alice"));
  await expect.element(screen.getByRole("alert")).toBeVisible();
  identity.reconnect();
  await screen.getByRole("button", { name: "Refresh workspaces" }).click();
  await expect
    .element(screen.getByRole("link", { name: "Research team" }))
    .toBeVisible();
});
