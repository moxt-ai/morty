import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import type {
    BotSetup,
    ManagedMobiusBot,
    MobiusBotsRequests,
} from "../../packages/web-core/src/view-models/mobius/requests.ts";
import { ProjectOwnerCredentials } from "../../packages/web-core/src/view-models/mobius/requests.ts";
import { MobiusBots } from "../../packages/web-core/src/views/workspace-applications/project-bot-management.tsx";

class MobiusWorkspace {
    readonly #setups = new Map<string, BotSetup>();
    readonly #setup = (botId: string): BotSetup =>
        this.#setups.get(botId) ?? {
            lifecycle: "draft",
            lifecycleRevision: 1,
            behaviorRevision: 0,
            configuration: { kind: "not-configured" },
            runtimes: [
                {
                    runtimeId: "runtime-one",
                    machineName: "Developer laptop",
                    workspaceName: "Customer team",
                    online: true,
                    agents: [
                        { id: "codex", label: "Codex" },
                        { id: "claude", label: "Claude" },
                    ],
                },
            ],
        };
    readonly approveSetup = (botId: string) => {
        const setup = this.#setup(botId);
        if (setup.configuration.kind !== "requested") {
            throw new Error("No setup pending");
        }
        this.#setups.set(botId, {
            ...setup,
            lifecycle: "active",
            configuration: { ...setup.configuration, kind: "approved" },
        });
        for (const [projectId, bots] of this.#bots) {
            this.#bots.set(
                projectId,
                bots.map((bot) =>
                    bot.botId === botId ? { ...bot, lifecycle: "active", setupStatus: "approved" } : bot,
                ),
            );
        }
    };
    readonly access = new ProjectOwnerCredentials("test", window.localStorage);
    #paired = false;
    readonly connectRuntime = () => {
        this.#paired = true;
    };
    readonly projectIds: readonly string[];
    constructor(projectIds: readonly string[] = ["project-one", "project-two"]) {
        this.projectIds = projectIds;
        for (const projectId of projectIds) {
            this.access.save({
                projectId,
                channelId: `channel-${projectId}`,
                tenantId: "test",
                hostToken: "o".repeat(32),
            });
        }
    }
    readonly #bots = new Map<string, readonly ManagedMobiusBot[]>([
        ["project-one", [{ botId: "one", displayName: "Support", lifecycle: "draft" }]],
        ["project-two", [{ botId: "two", displayName: "Engineering", lifecycle: "active" }]],
        ["project-new", [{ botId: "new", displayName: "New runtime bot", lifecycle: "draft" }]],
    ]);
    readonly requests: MobiusBotsRequests = {
        getBotSetup: async (_projectId, botId, signal) => {
            signal.throwIfAborted();
            return this.#setup(botId);
        },
        configureBot: async (projectId, botId, input, signal) => {
            signal.throwIfAborted();
            const setup: BotSetup = {
                ...this.#setup(botId),
                behaviorRevision: input.behaviorRevision + 1,
                lifecycleRevision: input.lifecycleRevision + 1,
                configuration: {
                    kind: "requested",
                    runtimeId: input.runtimeId,
                    agentRef: input.agentRef,
                    workspaceRef: input.workspaceRef,
                    instructions: input.instructions,
                },
            };
            this.#setups.set(botId, setup);
            this.#bots.set(
                projectId,
                (this.#bots.get(projectId) ?? []).map((bot) =>
                    bot.botId === botId ? { ...bot, setupStatus: "requested" } : bot,
                ),
            );
            return setup;
        },
        canManageProject: (projectId) => this.access.read(projectId) !== null,
        createPairing: async (signal) => {
            signal.throwIfAborted();
            this.access.save({
                projectId: "project-new",
                channelId: "channel-new",
                tenantId: "test",
                hostToken: "n".repeat(32),
            });
            return {
                pairingId: "pairing",
                projectId: "project-new",
                pairingCode: "ABC123",
                pollToken: "poll-token",
                expiresAt: "2026-09-09T00:10:00Z",
                relayUrl: "https://mobius.test",
            };
        },
        pairingStatus: async (_pairing, signal) => {
            signal.throwIfAborted();
            return this.#paired ? "paired" : "pending";
        },
        projectStatus: async (projectId, signal) => {
            signal.throwIfAborted();
            return projectId === "project-new" && this.#paired ? "connected" : "offline";
        },
        listProjects: async (signal) => {
            signal.throwIfAborted();
            return [
                { projectId: "project-one", displayName: "Customer team" },
                { projectId: "project-two", displayName: "Product team" },
            ]
                .filter((project) => this.projectIds.includes(project.projectId))
                .concat(this.#paired ? [{ projectId: "project-new", displayName: "New runtime" }] : []);
        },
        listBots: async (projectId, signal) => {
            signal.throwIfAborted();
            return this.#bots.get(projectId) ?? [];
        },
        createBot: async (projectId, input, signal) => {
            signal.throwIfAborted();
            if (this.access.read(projectId) === null) {
                throw new Error("Project owner credential required");
            }
            const bot = { botId: "created", displayName: input.displayName, lifecycle: "draft" };
            this.#bots.set(projectId, [...(this.#bots.get(projectId) ?? []), bot]);
            return bot;
        },
    };
}
beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

test("Given a bot needing setup, When its owner selects a local agent and the runtime approves the configuration, Then the bot becomes ready with its saved instructions", async () => {
    const workspace = new MobiusWorkspace(["project-one"]);
    const screen = await render(
        <StrictMode>
            <MobiusBots requests={workspace.requests} />
        </StrictMode>,
    );
    await expect.element(screen.getByText("Needs setup", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Set up Support", exact: true }).click();
    await screen.getByLabelText("Local agent", { exact: true }).click();
    await screen.getByRole("option", { name: "Claude", exact: true }).click();
    await screen
        .getByLabelText("Bot instructions", { exact: true })
        .fill("Help the support team triage incoming requests.");
    await screen.getByRole("button", { name: "Save setup", exact: true }).click();
    await expect
        .element(screen.getByRole("dialog").getByText("Awaiting runtime approval", { exact: true }))
        .toBeVisible();
    workspace.approveSetup("one");
    await screen.getByRole("button", { name: "Refresh setup status", exact: true }).click();
    await expect.element(screen.getByRole("dialog").getByText("Ready", { exact: true })).toBeVisible();
    await expect.element(screen.getByLabelText("Local agent", { exact: true })).toHaveTextContent("Claude");
    await expect
        .element(screen.getByLabelText("Bot instructions", { exact: true }))
        .toHaveValue("Help the support team triage incoming requests.");
});

test("Given a project is offline, When a user adds and completes a new pairing in the Mobius bots card, Then the new project is selected and shown connected", async () => {
    const workspace = new MobiusWorkspace(["project-one"]);
    const screen = await render(
        <StrictMode>
            <MobiusBots requests={workspace.requests} />
        </StrictMode>,
    );
    await expect
        .element(screen.getByRole("listitem", { name: "Support" }).getByText("offline", { exact: true }))
        .toBeVisible();
    await screen.getByRole("button", { name: "Pair new project" }).click();
    await expect.element(screen.getByRole("dialog", { name: "Pair a Mobius runtime" })).toBeVisible();
    await expect
        .element(screen.getByLabelText("Pairing command"))
        .toHaveValue('npx --yes @moxt-ai/mobius pair --url "https://mobius.test" --code ABC123');
    workspace.connectRuntime();
    await screen.getByRole("button", { name: "Check pairing" }).click();
    await screen.getByRole("button", { name: "Use project" }).click();
    await expect.element(screen.getByLabelText("Mobius project")).toHaveTextContent("New runtime");
    await expect
        .element(screen.getByRole("listitem", { name: "New runtime bot" }).getByText("connected", { exact: true }))
        .toBeVisible();
    await screen.unmount();
    const reopened = await render(
        <StrictMode>
            <MobiusBots requests={workspace.requests} />
        </StrictMode>,
    );
    await reopened.getByLabelText("Mobius project").click();
    await reopened.getByRole("option", { name: "New runtime", exact: true }).click();
    await reopened.getByRole("button", { name: "Add Mobius bot" }).click();
    await reopened.getByLabelText("Mobius bot name").fill("Saved access bot");
    await reopened.getByRole("button", { name: "Create Mobius bot", exact: true }).click();
    await expect.element(reopened.getByText("Saved access bot", { exact: true })).toBeVisible();
});

test("Given a workspace with one project, When Mobius bot management opens, Then that project's bots load automatically", async () => {
    const workspace = new MobiusWorkspace(["project-one"]);
    const screen = await render(
        <StrictMode>
            <MobiusBots requests={workspace.requests} />
        </StrictMode>,
    );
    await expect.element(screen.getByLabelText("Mobius project")).toHaveTextContent("Customer team");
    await expect.element(screen.getByText("Support", { exact: true })).toBeVisible();
});

test("Given a workspace with two projects, When a member selects a project and adds a Mobius bot, Then its persisted list contains only that project's bots", async () => {
    const workspace = new MobiusWorkspace();
    const screen = await render(
        <StrictMode>
            <MobiusBots requests={workspace.requests} />
        </StrictMode>,
    );
    await screen.getByLabelText("Mobius project").click();
    await screen.getByRole("option", { name: "Customer team", exact: true }).click();
    await expect.element(screen.getByText("Support", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Add Mobius bot" }).click();
    await screen.getByLabelText("Mobius bot name").fill("Operations");
    await expect.element(screen.getByLabelText("Project owner credential")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Create Mobius bot", exact: true }).click();
    await expect.element(screen.getByText("Operations", { exact: true })).toBeVisible();
    await screen.getByLabelText("Mobius project").click();
    await screen.getByRole("option", { name: "Product team", exact: true }).click();
    await expect.element(screen.getByText("Engineering", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Operations", { exact: true })).not.toBeInTheDocument();
    await screen.getByLabelText("Mobius project").click();
    await screen.getByRole("option", { name: "Customer team", exact: true }).click();
    await expect.element(screen.getByText("Operations", { exact: true })).toBeVisible();
});

import { StrictMode } from "react";
