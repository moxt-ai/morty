import assert from "node:assert/strict";
import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given a paired workspace, When a user works across conversations, Then attachments, queued work, replies, and revisits remain usable", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;

    let firstConversationId = "";
    await test.step("create the first conversation with an image", async () => {
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
        await composer.fill("First conversation");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page).toHaveURL(/\?conversationId=/u);
        await expect(page.getByRole("list", { name: "Attachments", exact: true })).toHaveCount(0);
        await expect(page.getByTestId(dataTestId.agentResponse).first()).toContainText("First conversation");
        firstConversationId = new URL(page.url()).searchParams.get("conversationId") ?? "";
        assert.notEqual(firstConversationId, "");
    });

    await test.step("create, continue, reload, and revisit conversations", async () => {
        await page.getByTestId(dataTestId.newConversation).click();
        const originalDocument = await page.locator("html").elementHandle();
        assert.ok(originalDocument);
        await runtime.sendMessage("Second conversation");
        await expect(page.getByTestId(dataTestId.agentResponse).first()).toContainText("Second conversation");
        expect(await originalDocument.evaluate((element) => element.isConnected)).toBe(true);
        await expect(page.getByTestId(dataTestId.userMessage).last()).toHaveText("Second conversation");
        const secondConversationId = new URL(page.url()).searchParams.get("conversationId");
        assert.ok(secondConversationId);
        expect(secondConversationId).not.toBe(firstConversationId);
        await originalDocument.dispose();

        const followUp = "Continue the second conversation";
        await runtime.sendMessage(followUp);
        await expect(page.getByTestId(dataTestId.agentResponse).nth(1)).toContainText(followUp);
        const savedUrl = page.url();
        await page.reload();
        await expect(page.getByTestId(dataTestId.agentResponse).nth(1)).toContainText(followUp);
        expect(page.url()).toBe(savedUrl);
        await expect(page.getByTestId(dataTestId.userMessage)).toHaveText(["Second conversation", followUp]);

        await page.goto(`${new URL(page.url()).origin}/?conversationId=${firstConversationId}`);
        await expect(page.getByTestId(dataTestId.userMessage)).toHaveText(["First conversation"]);
    });

    await test.step("queue a follow-up while the agent is working", async () => {
        await page.getByTestId(dataTestId.newConversation).click();
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
});
