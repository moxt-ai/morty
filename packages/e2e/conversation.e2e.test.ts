import assert from "node:assert/strict";
import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given a paired workspace, When a user works across conversations, Then attachments, sharing, history, and forks remain usable", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    const composer = page.getByTestId(dataTestId.messageComposer);

    await test.step("attach context and complete the first conversation", async () => {
        await expect(composer).toHaveAttribute("placeholder", "Ask me anything");
        await page.getByRole("button", { name: "Add", exact: true }).click();
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("menuitem", { name: "Add attachment", exact: true }).click();
        await (await chooser).setFiles({
            name: "project-notes.md",
            mimeType: "text/markdown",
            buffer: Buffer.from("# Project notes\nKeep the reply brief."),
        });
        await expect(page.getByText("project-notes.md", { exact: true })).toBeVisible();

        await runtime.sendMessage("First conversation");
        await expect(page.getByTestId(dataTestId.agentResponse).last()).toContainText("First conversation");
        await expect(page.getByRole("status", { name: "Agent working" })).toHaveCount(0);
    });

    await test.step("create a fresh machine-sharing link", async () => {
        await page.getByRole("button", { name: "Share My Machine", exact: true }).click();
        const share = page.getByRole("dialog", { name: "Share My Machine", exact: true });
        await expect(share.getByRole("img", { name: "Machine sharing QR code", exact: true })).toBeVisible();
        const url = await share.getByRole("link", { name: "Open sharing link", exact: true }).getAttribute("href");
        assert.match(url ?? "", /\/continue#code=/u);
        await expect(share.getByText(/used up to five times/iu)).toBeVisible();
        await share.getByRole("button", { name: "Close dialog", exact: true }).click();
    });

    let secondConversationUrl = "";
    await test.step("create, continue, and reload another conversation", async () => {
        await page.getByTestId(dataTestId.newConversation).click();
        await runtime.sendMessage("Second conversation");
        await expect(page.getByTestId(dataTestId.agentResponse).last()).toContainText("Second conversation");
        await runtime.sendMessage("Continue the second conversation");
        await expect(page.getByTestId(dataTestId.agentResponse).last()).toContainText(
            "Continue the second conversation",
        );
        secondConversationUrl = page.url();
        await page.reload();
        expect(page.url()).toBe(secondConversationUrl);
        await expect(page.getByTestId(dataTestId.userMessage)).toHaveText([
            "Second conversation",
            "Continue the second conversation",
        ]);
    });

    await test.step("switch to the first conversation and fork its native session", async () => {
        const sidebar = page.getByRole("complementary", { name: "Conversations", exact: true });
        await sidebar.getByRole("button", { name: "First conversation", exact: true }).click();
        await expect(page.getByTestId(dataTestId.userMessage)).toHaveText(["First conversation"]);

        await page.getByRole("button", { name: "Native Sessions", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Native Sessions", exact: true });
        await dialog.getByRole("combobox", { name: "Session agent", exact: true }).click();
        await page.getByRole("option", { name: /^OpenCode ·/u }).click();
        await dialog.getByRole("button", { name: /First conversation/u }).click();
        await expect(dialog.getByRole("region", { name: "Selected session preview" })).toContainText(
            "First conversation",
        );
        await dialog.getByRole("button", { name: "Fork", exact: true }).click();
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Continue only the fork");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText(
            /OpenCode turn \d+: Continue only the fork/u,
        );
        await page.reload();
        await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText("First conversation");
        await page.goto(secondConversationUrl);
        await expect(page.getByTestId(dataTestId.userMessage)).toHaveText([
            "Second conversation",
            "Continue the second conversation",
        ]);
    });
});
