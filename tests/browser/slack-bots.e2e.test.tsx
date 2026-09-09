import { type ManagementRequests, SlackBots } from "@moxt-ai/app-slack-web-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

// Stateful management service at the browser's production request port; no live Slack/Clerk credentials are needed.
class SlackManagementDirectory {
    readonly #bindings = new Map<string, string>();
    readonly #owners = new Map([
        ["mobius-first", "project-first"],
        ["mobius-second", "project-second"],
    ]);
    readonly requests: ManagementRequests = {
        listBindableBots: async (signal) => {
            signal.throwIfAborted();
            return [...this.#owners].map(([botId, projectId]) => ({ botId, projectId, displayName: botId }));
        },
        listBots: async (signal) => {
            signal.throwIfAborted();
            const botId = this.#bindings.get("slack-bot");
            return [
                {
                    id: "slack-bot",
                    name: "Support",
                    binding: botId === undefined ? { kind: "unbound" } : { kind: "bound", botId },
                },
            ];
        },
        getConnection: async (slackBotId, signal) => {
            signal.throwIfAborted();
            return slackBotId === "slack-bot"
                ? {
                      kind: "connected",
                      appName: "Support",
                      slackAppId: "A123",
                      slackTeamId: "T123",
                      slackTeamName: "Support workspace",
                  }
                : { kind: "not-configured" };
        },
        bindBot: async (slackBotId, input, signal) => {
            signal.throwIfAborted();
            if (slackBotId !== "slack-bot" || this.#owners.get(input.botId) !== input.projectId) {
                throw new Error("Bot ownership required");
            }
            this.#bindings.set(slackBotId, input.botId);
            return { kind: "bound", botId: input.botId };
        },
        getManifest: async (name) => ({ display_information: { name } }),
        registerApp: async () => {
            throw new Error("Slack installation requires the external provider");
        },
        createApp: async () => {
            throw new Error("Slack installation requires the external provider");
        },
        getAuthorizationUrl: async () => {
            throw new Error("Slack installation requires the external provider");
        },
        disconnectApp: async () => {
            throw new Error("Slack installation requires the external provider");
        },
        saveConfigToken: async () => {
            throw new Error("Slack installation requires the external provider");
        },
    };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
});
afterEach(() => {
    vi.useRealTimers();
});

test("Given an installed unbound Slack bot, When its owner first binds and then changes its Mobius bot, Then the chosen binding survives reopening and the Slack installation stays connected", async () => {
    const directory = new SlackManagementDirectory();
    const screen = await render(<SlackBots requests={directory.requests} canManage />);
    await expect.element(screen.getByText("Mobius bot: Unbound")).toBeVisible();
    await screen.getByText("Bind Mobius bot", { exact: true }).click();
    await screen.getByLabelText("Mobius bot", { exact: true }).click();
    await screen.getByRole("option", { name: "mobius-first", exact: true }).click();
    await expect.element(screen.getByLabelText("Mobius owner credential")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Save binding" }).click();
    await expect.element(screen.getByText("Mobius bot: mobius-first")).toBeVisible();
    await screen.getByLabelText("Mobius bot", { exact: true }).click();
    await screen.getByRole("option", { name: "mobius-second", exact: true }).click();
    await screen.getByRole("button", { name: "Save binding" }).click();
    await expect.element(screen.getByText("Mobius bot: mobius-second")).toBeVisible();
    await screen.unmount();
    const reopened = await render(<SlackBots requests={directory.requests} canManage />);
    await expect.element(reopened.getByText("Mobius bot: mobius-second")).toBeVisible();
    await expect.element(reopened.getByText("Connected to Support workspace")).toBeVisible();
});

test("Given a workspace owner, When they start configuring a new Slack bot, Then Slack setup is available before a Mobius bot is bound", async () => {
    const directory = new SlackManagementDirectory();
    const screen = await render(<SlackBots requests={directory.requests} canManage />);
    await screen.getByRole("button", { name: "Add Slack bot" }).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await expect.element(screen.getByRole("article", { name: "New Slack bot", exact: true })).not.toBeInTheDocument();
    await expect
        .element(screen.getByRole("tab", { name: "OAuth", exact: true }))
        .toHaveAttribute("aria-selected", "true");
    await expect.element(screen.getByLabelText("Slack app configuration refresh token")).toBeVisible();
    await screen.getByLabelText("Slack bot name").fill("Discard this draft");
    await screen.getByRole("tab", { name: "Manual Configure", exact: true }).click();
    await expect.element(screen.getByLabelText("Client secret", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Close", exact: true }).click();
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("article", { name: "New Slack bot", exact: true })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Add Slack bot" }).click();
    await expect.element(screen.getByLabelText("Slack bot name")).toHaveValue("New Slack bot");
});
