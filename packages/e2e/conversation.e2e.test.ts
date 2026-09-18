import assert from "node:assert/strict";
import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given a paired workspace, When the user pastes an image into the chat box, Then the image can be sent", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    const composer = page.getByTestId(dataTestId.messageComposer);

    await composer.evaluate((element) => {
        const bytes = Uint8Array.from(
            atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
            (character) => character.charCodeAt(0),
        );
        const clipboard = new DataTransfer();
        clipboard.items.add(new File([bytes], "pasted-image.png", { type: "image/png" }));
        element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: clipboard }));
    });

    await expect(page.getByRole("list", { name: "Attachments", exact: true })).toContainText("pasted-image.png");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page).toHaveURL(/\?conversationId=/u);
    await expect(page.getByRole("list", { name: "Attachments", exact: true })).toHaveCount(0);
});

test("Given an agent is working, When the user sends a follow-up, Then the follow-up is queued", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    const composer = page.getByTestId(dataTestId.messageComposer);
    const send = page.getByTestId(dataTestId.sendMessage);

    await composer.fill("wait for steering");
    await send.click();
    await expect(send).toHaveAttribute("aria-label", "Stop agent output");

    await expect(composer).toBeEnabled();
    await composer.fill("focus on the public API");
    await composer.press("Enter");

    await expect(page.getByTestId(dataTestId.queuedMessage)).toHaveText("focus on the public API");
});

test("Given a paired workspace, When a user creates and reloads conversations, Then prompts and replies stay in their selected conversation", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    const conversationIds = new Set();
    for (const prompt of ["First conversation", "Second conversation"]) {
        const composer = page.getByTestId(dataTestId.messageComposer);
        await expect(composer).toBeVisible();
        const originalDocument = await page.locator("html").elementHandle();
        assert.ok(originalDocument);
        await runtime.sendMessage(prompt);
        await expect(page.getByTestId(dataTestId.agentResponse).first()).toContainText(prompt);
        expect(await originalDocument.evaluate((element) => element.isConnected)).toBe(true);
        await expect(page.getByTestId(dataTestId.userMessage).last()).toHaveText(prompt);
        const conversationId = new URL(page.url()).searchParams.get("conversationId");
        expect(conversationId).toBeTruthy();
        expect(conversationIds.has(conversationId)).toBe(false);
        conversationIds.add(conversationId);
        if (prompt === "First conversation") {
            await page.getByTestId(dataTestId.newConversation).click();
        }
        await originalDocument.dispose();
    }

    const followUp = "Continue the second conversation";
    await runtime.sendMessage(followUp);
    await expect(page.getByTestId(dataTestId.agentResponse).nth(1)).toContainText(followUp);
    const savedUrl = page.url();
    await page.reload();
    await expect(page.getByTestId(dataTestId.agentResponse).nth(1)).toContainText(followUp);
    expect(page.url()).toBe(savedUrl);
    await expect(page.getByTestId(dataTestId.userMessage)).toHaveText(["Second conversation", followUp]);

    const sidebar = page.getByRole("complementary", { name: "Conversations", exact: true });
    await sidebar.getByRole("button", { name: "First conversation", exact: true }).click();
    await expect(page.getByTestId(dataTestId.userMessage)).toHaveText(["First conversation"]);
});
