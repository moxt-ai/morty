import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given a paired workspace, When a user sends an image to an Agent, Then the response and history remain visible", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    await expect(page.getByTestId(dataTestId.botConnectionStatus)).toHaveText("Connected");
    await test.step("share the machine from the unobstructed sidebar action", async () => {
        await page.getByTestId(dataTestId.shareMachine).click();
        await expect(page.getByTestId(dataTestId.machineSharing)).toBeVisible();
        await page.keyboard.press("Escape");
    });

    await test.step("send one image prompt through the deployed-style stack", async () => {
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
        await expect(page.getByTestId(dataTestId.queuedMessage)).toHaveText("First conversation");
        await expect(page.getByTestId(dataTestId.initialMessageStatus)).toHaveText("Session creating");
        await expect(page).toHaveURL(/\?conversationId=/u);
        await expect(page.getByRole("list", { name: "Attachments", exact: true })).toHaveCount(0);
        await expect(page.getByTestId(dataTestId.agentResponse).first()).toContainText("First conversation");
        await expect(page.getByTestId(dataTestId.agentReplyStatus)).toHaveCount(0);
        await expect(page.getByTestId(dataTestId.workingIndicator)).toHaveCount(0);
        await expect(page.getByTestId(dataTestId.sendMessage)).toHaveAttribute("aria-label", "Send message");
        await expect(page.getByTestId(dataTestId.recognizedReadToolCall).first()).toContainText(
            "Read package metadata",
        );
    });

    await test.step("reload the same conversation from persisted history", async () => {
        const conversationUrl = page.url();
        await page.reload();
        expect(page.url()).toBe(conversationUrl);
        await expect(page.getByTestId(dataTestId.userMessage)).toHaveText(["First conversation"]);
        await expect(page.getByTestId(dataTestId.agentResponse).first()).toContainText("First conversation");
        await expect(page.getByTestId(dataTestId.userMessageImage)).toBeVisible();
    });
});
