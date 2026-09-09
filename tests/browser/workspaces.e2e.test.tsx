import {
    BrowserWorkspaceConnections,
    type ChatApplicationProps,
    createWorkspaceRouter,
    type ProjectApplicationProps,
    WorkspaceApplications,
    type WorkspaceConnectionProps,
    type WorkspaceDirectory,
    WorkspaceError,
    type WorkspaceShellProps,
} from "@moxt-ai/mobius-cloud-web-core";
import { RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { WorkspaceIdentityProvider } from "../support/workspace-directory.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
    machines = new MachineDirectory();
});
afterEach(() => {
    vi.useRealTimers();
});
interface TestConnection {
    readonly channelId: string;
}

class MachineDirectory {
    readonly #channels = new Map<string, TestConnection>();
    readonly pair = (): TestConnection => {
        const connection = { channelId: "channel-1" };
        this.#channels.set(connection.channelId, connection);
        return connection;
    };
    readonly read = async (channelId: string, signal: AbortSignal): Promise<TestConnection> => {
        signal.throwIfAborted();
        const connection = this.#channels.get(channelId);
        if (connection === undefined) {
            throw new WorkspaceError("UNAVAILABLE");
        }
        return connection;
    };
}

let machines = new MachineDirectory();

async function renderWorkspaces(directory: WorkspaceDirectory, userId = "alice") {
    const ProjectsApplication = ({ onChannelSelected }: ProjectApplicationProps) => (
        <>
            <h2>Project and bot management</h2>
            <button type="button" onClick={() => onChannelSelected(machines.pair().channelId)}>
                Select paired project
            </button>
        </>
    );
    const ChatApplication = ({ connection }: ChatApplicationProps<TestConnection>) => (
        <p>Chat is ready for {connection.channelId}.</p>
    );
    const SlackApplication = () => <p>Slack bots are ready.</p>;
    const WorkspaceManagement = (props: WorkspaceConnectionProps<TestConnection>) => (
        <WorkspaceApplications
            {...props}
            ChatApplication={ChatApplication}
            SlackApplication={SlackApplication}
            ProjectsApplication={ProjectsApplication}
        />
    );
    const router = createWorkspaceRouter(
        directory,
        async (signal) => {
            signal.throwIfAborted();
        },
        WorkspaceManagement,
        new BrowserWorkspaceConnections(userId, window.localStorage, machines.read),
        {
            Standard: ({ children }: WorkspaceShellProps) => <div>{children}</div>,
            Application: ({ children }: WorkspaceShellProps) => (
                <main aria-label="Full application view">{children}</main>
            ),
        },
    );
    return render(<RouterProvider router={router} />);
}

test("Given a signed-in user, When they open a workspace and navigate to Chat and Slack, Then management and each application have separate page views", async () => {
    const identity = new WorkspaceIdentityProvider();
    const screen = await renderWorkspaces(identity.forUser("alice"));
    await expect.element(screen.getByRole("heading", { name: "Workspaces", exact: true })).toBeVisible();
    await expect.element(screen.getByText("No workspaces yet")).toBeVisible();
    await screen.getByRole("button", { name: "New workspace" }).click();
    await screen.getByLabelText("Workspace name").fill("Research team");
    await screen.getByRole("button", { name: "Create workspace", exact: true }).click();
    await screen.getByRole("link", { name: "Research team" }).click();
    await expect.element(screen.getByRole("heading", { name: "Project and bot management" })).toBeVisible();
    await expect.element(screen.getByRole("main", { name: "Full application view" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("link", { name: "Open Slack" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Complete pairing" })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Select paired project" }).click();
    await screen.getByRole("link", { name: "Open Chat" }).click();
    expect(window.location.pathname).toMatch(/\/workspaces\/[^/]+\/chat$/u);
    await expect.element(screen.getByRole("main", { name: "Full application view" })).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "Project and bot management" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Complete pairing" })).not.toBeInTheDocument();
    await expect.element(screen.getByText("Chat is ready for channel-1.")).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "Chat", exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByText("Research team", { exact: true })).not.toBeInTheDocument();
    await screen.getByRole("link", { name: "All workspaces" }).click();
    await screen.getByRole("link", { name: "Research team" }).click();
    await screen.getByRole("link", { name: "Open Slack" }).click();
    expect(window.location.pathname).toMatch(/\/workspaces\/[^/]+\/slack$/u);
    await expect.element(screen.getByRole("main", { name: "Full application view" })).toBeVisible();
    await expect.element(screen.getByText("Chat is ready for channel-1.")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Slack bots are ready.")).toBeVisible();
    await expect.element(screen.getByText("Research team", { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { name: "Slack", exact: true })).not.toBeInTheDocument();
    await screen.getByRole("link", { name: "All workspaces" }).click();
    await screen.getByRole("button", { name: "Delete Research team" }).click();
    await screen.getByRole("button", { name: "Cancel" }).click();
    await expect.element(screen.getByRole("link", { name: "Research team" })).toBeVisible();
    await screen.getByRole("button", { name: "Delete Research team" }).click();
    await screen.getByRole("button", { name: "Delete workspace", exact: true }).click();
    await expect.element(screen.getByText("No workspaces yet")).toBeVisible();
});

test("Given a workspace creation dialog, When the user dismisses it, Then focus returns to its trigger and the unsaved draft is discarded", async () => {
    const identity = new WorkspaceIdentityProvider();
    const screen = await renderWorkspaces(identity.forUser("alice"));
    await screen.getByRole("button", { name: "New workspace", exact: true }).click();
    await expect.element(screen.getByRole("textbox", { name: "Workspace name" })).toHaveFocus();
    await screen.getByRole("textbox", { name: "Workspace name" }).fill("Unsaved team");
    await screen.getByRole("button", { name: "Close dialog" }).click();
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "New workspace", exact: true })).toHaveFocus();
    await screen.getByRole("button", { name: "New workspace", exact: true }).click();
    await expect.element(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue("");
});

test("Given memberships in two workspaces, When a user views their list, Then only their workspaces appear and only their managed workspace can be deleted", async () => {
    const identity = new WorkspaceIdentityProvider();
    identity.create("Alice's team", "alice");
    const shared = identity.create("Shared team", "bob");
    identity.invite(shared, "alice");
    identity.create("Private team", "bob");
    const screen = await renderWorkspaces(identity.forUser("alice"));
    await expect.element(screen.getByRole("link", { name: "Alice's team" })).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "Shared team" })).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "Private team" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Delete Alice's team" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Delete Shared team" })).not.toBeInTheDocument();
});

test("Given a workspace URL belonging to another user, When it is opened directly, Then access is denied and the user can return to their workspaces", async () => {
    const identity = new WorkspaceIdentityProvider();
    const privateId = identity.create("Private team", "bob");
    window.history.replaceState(null, "", `/workspaces/${privateId}`);
    const screen = await renderWorkspaces(identity.forUser("alice"));
    await expect.element(screen.getByRole("alert")).toHaveTextContent("no longer have access");
    await expect.element(screen.getByRole("link", { name: "Open Slack" })).not.toBeInTheDocument();
    await screen.getByRole("link", { name: "All workspaces" }).click();
    await expect.element(screen.getByText("No workspaces yet")).toBeVisible();
});

test("Given more than one page of memberships, When a user changes pages and opens a workspace, Then later workspaces remain accessible through their URL", async () => {
    const identity = new WorkspaceIdentityProvider();
    for (let i = 1; i <= 21; i += 1) {
        identity.create(`Team ${i}`, "alice");
    }
    const screen = await renderWorkspaces(identity.forUser("alice"));
    await screen.getByRole("link", { name: "Next", exact: true }).click();
    await expect.element(screen.getByRole("link", { name: "Team 21", exact: true })).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "Team 1", exact: true })).not.toBeInTheDocument();
    await screen.getByRole("link", { name: "Team 21", exact: true }).click();
    await expect.element(screen.getByRole("link", { name: "Open Slack" })).toBeVisible();
    const path = window.location.pathname;
    await screen.unmount();
    window.history.replaceState(null, "", path);
    const reopened = await renderWorkspaces(identity.forUser("alice"));
    await expect.element(reopened.getByText("Team 21", { exact: true })).toBeVisible();
});

test("Given an unavailable identity provider, When connectivity returns and the user refreshes, Then the workspace list recovers", async () => {
    const identity = new WorkspaceIdentityProvider();
    identity.create("Research team", "alice");
    identity.disconnect();
    const screen = await renderWorkspaces(identity.forUser("alice"));
    await expect.element(screen.getByRole("alert")).toBeVisible();
    identity.reconnect();
    await screen.getByRole("button", { name: "Refresh workspaces" }).click();
    await expect.element(screen.getByRole("link", { name: "Research team" })).toBeVisible();
});

test("Given a paired workspace, When the user reloads its page, Then Chat and Slack recover the existing machine without pairing again", async () => {
    const identity = new WorkspaceIdentityProvider();
    const id = identity.create("Connected team", "alice");
    window.history.replaceState(null, "", `/workspaces/${id}`);
    const screen = await renderWorkspaces(identity.forUser("alice"));
    await screen.getByRole("button", { name: "Select paired project" }).click();
    await screen.getByRole("link", { name: "Open Chat" }).click();
    await expect.element(screen.getByText("Chat is ready for channel-1.")).toBeVisible();
    const path = window.location.pathname + window.location.search;
    await screen.unmount();
    window.history.replaceState(null, "", path);
    const reopened = await renderWorkspaces(identity.forUser("alice"));
    await expect.element(reopened.getByText("Chat is ready for channel-1.")).toBeVisible();
    await expect.element(reopened.getByRole("button", { name: "Complete pairing" })).not.toBeInTheDocument();
    await reopened.getByRole("link", { name: "All workspaces" }).click();
    await reopened.getByRole("link", { name: "Connected team" }).click();
    await reopened.getByRole("link", { name: "Open Slack" }).click();
    await expect.element(reopened.getByText("Slack bots are ready.")).toBeVisible();
});

test("Given a paired workspace, When another workspace or another signed-in member is opened, Then the saved machine is not reused across either boundary", async () => {
    const identity = new WorkspaceIdentityProvider();
    const first = identity.create("First team", "alice");
    const second = identity.create("Second team", "alice");
    identity.invite(first, "bob");
    window.history.replaceState(null, "", `/workspaces/${first}`);
    const screen = await renderWorkspaces(identity.forUser("alice"));
    await screen.getByRole("button", { name: "Select paired project" }).click();
    await screen.getByRole("link", { name: "Open Chat" }).click();
    await expect.element(screen.getByText("Chat is ready for channel-1.")).toBeVisible();
    await screen.unmount();
    window.history.replaceState(null, "", `/workspaces/${second}/chat`);
    const otherWorkspace = await renderWorkspaces(identity.forUser("alice"));
    await expect
        .element(otherWorkspace.getByText("Select a paired project in workspace management to open Chat."))
        .toBeVisible();
    await expect.element(otherWorkspace.getByRole("button", { name: "Complete pairing" })).not.toBeInTheDocument();
    await otherWorkspace.unmount();
    window.history.replaceState(null, "", `/workspaces/${first}/chat`);
    const otherUser = await renderWorkspaces(identity.forUser("bob"), "bob");
    await expect
        .element(otherUser.getByText("Select a paired project in workspace management to open Chat."))
        .toBeVisible();
    await otherUser.unmount();
    const originalUser = await renderWorkspaces(identity.forUser("alice"));
    await expect.element(originalUser.getByText("Chat is ready for channel-1.")).toBeVisible();
});

test("Given an existing paired channel, When its workspace recovery link is opened, Then later visits to the plain workspace URL restore it", async () => {
    const identity = new WorkspaceIdentityProvider();
    const id = identity.create("Recovered team", "alice");
    const channel = machines.pair();
    window.history.replaceState(null, "", `/workspaces/${id}/chat?channel=${channel.channelId}`);
    const screen = await renderWorkspaces(identity.forUser("alice"));
    await expect.element(screen.getByText("Chat is ready for channel-1.")).toBeVisible();
    await screen.unmount();
    window.history.replaceState(null, "", `/workspaces/${id}`);
    const reopened = await renderWorkspaces(identity.forUser("alice"));
    await reopened.getByRole("link", { name: "Open Chat" }).click();
    await expect.element(reopened.getByText("Chat is ready for channel-1.")).toBeVisible();
});

test("Given a workspace recovery link for an inaccessible channel, When it is opened, Then restoration fails visibly without silently asking to pair again", async () => {
    const identity = new WorkspaceIdentityProvider();
    const id = identity.create("Unavailable machine", "alice");
    window.history.replaceState(null, "", `/workspaces/${id}?channel=unavailable`);
    const screen = await renderWorkspaces(identity.forUser("alice"));
    await expect.element(screen.getByRole("alert")).toHaveTextContent("saved machine connection could not be restored");
    await expect.element(screen.getByRole("button", { name: "Complete pairing" })).not.toBeInTheDocument();
});
