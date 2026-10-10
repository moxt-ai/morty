import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given a linked TypeScript file longer than the preview, When the user opens it, Then the complete numbered and highlighted source fills the scrollable overlay", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();

    await page.getByRole("textbox", { name: "Message" }).fill("show source file");
    await page.getByRole("button", { name: "Send message" }).click();
    const messages = page.getByRole("log", { name: "Messages" });
    const openSource = page.getByRole("button", { name: "Open source" });
    await expect(openSource).toBeVisible();
    const messagesBoxBefore = await messages.boundingBox();
    await openSource.click();

    const preview = page.getByRole("complementary", { name: "Local file preview" });
    await expect(preview).toContainText("export function FileExplorer");
    const highlightedTokens = preview.locator('code span[style*="--sdm-c"]');
    await expect(highlightedTokens.first()).toBeVisible();
    const lineNumbers = preview.locator(`[data-testid="${dataTestId.filePreviewLineNumbers}"] [data-line-number]`);
    await expect(lineNumbers).toHaveCount(53);
    await expect(lineNumbers.last()).toHaveText("53");
    const firstLineNumberBox = await lineNumbers.first().boundingBox();
    const firstCodeLineBox = await preview.locator("code > span").first().boundingBox();
    expect(firstLineNumberBox).not.toBeNull();
    expect(firstCodeLineBox).not.toBeNull();
    if (firstLineNumberBox === null || firstCodeLineBox === null) {
        throw new Error("Expected the first line number and source line to have browser layout boxes");
    }
    expect(firstLineNumberBox.y).toBeCloseTo(firstCodeLineBox.y, 0);
    await expect
        .poll(async () => {
            const colors = await highlightedTokens.evaluateAll((tokens) =>
                Array.from(new Set(tokens.map((token) => getComputedStyle(token).color))),
            );
            return colors.length;
        })
        .toBeGreaterThan(1);
    await expect(preview.getByText("tsx", { exact: true })).toBeHidden();
    await expect(preview.getByRole("button", { name: "Copy code" })).toBeHidden();
    await expect(preview.locator('[data-streamdown="code-block"]')).toHaveCSS("border-top-width", "0px");
    const codeBody = preview.locator('[data-streamdown="code-block-body"]');
    await expect(codeBody).toContainText("export const fileExplorerEnd = true;");
    await expect
        .poll(async () => {
            const box = await codeBody.boundingBox();
            return box?.height ?? 0;
        })
        .toBeGreaterThan(400);
    const fileContents = preview.getByRole("region", { name: "File contents" });
    await expect(fileContents).toBeVisible();
    await expect
        .poll(async () => await fileContents.evaluate((element) => element.scrollHeight - element.clientHeight))
        .toBeGreaterThan(0);
    await fileContents.focus();
    await page.keyboard.press("End");
    await expect.poll(async () => await fileContents.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const messagesBox = await messages.boundingBox();
    const previewBox = await preview.boundingBox();
    expect(messagesBoxBefore).not.toBeNull();
    expect(messagesBox).not.toBeNull();
    expect(previewBox).not.toBeNull();
    if (messagesBoxBefore === null || messagesBox === null || previewBox === null) {
        throw new Error("Expected the conversation and preview to have browser layout boxes");
    }
    expect(messagesBox.width).toBeCloseTo(messagesBoxBefore.width, 0);
    expect(previewBox.x).toBeLessThan(messagesBox.x + messagesBox.width);
    expect(previewBox.x + previewBox.width).toBeCloseTo(page.viewportSize()?.width ?? 0, 0);
    await page.screenshot({ fullPage: true, path: testInfo.outputPath("file-preview.png") });
});

test("Given a paired Bot, When a user sends and observes prompts across pages, Then live and completed replies remain consistent", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();

    await page.getByRole("textbox", { name: "Message" }).fill("First conversation");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page).toHaveURL(/\?sessionId=[^&#]+/u);
    const workingConversation = page.getByRole("button", { name: /First conversation.*Session working/u });
    const firstConversationResponse = page
        .getByRole("article", { name: "Agent response" })
        .filter({ hasText: "First conversation" });
    await expect(firstConversationResponse).toHaveCount(1);
    await expect(firstConversationResponse).toBeVisible();

    await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden();
    await expect(workingConversation).toBeHidden();
    const sessionUrl = page.url();
    await page.reload();
    await expect(page).toHaveURL(sessionUrl);
    await expect(firstConversationResponse).toHaveCount(1);
    await expect(firstConversationResponse).toBeVisible();

    await page.getByRole("button", { name: "New Conversation" }).click();
    await page.getByRole("textbox", { name: "Message" }).fill("hold after first delta");
    await page.getByRole("button", { name: "Send message" }).click();
    const partialResponse = page.getByRole("article", { name: "Agent response" }).filter({ hasText: "Partial reply" });
    await expect(partialResponse).toHaveCount(1);
    await expect(partialResponse).toBeVisible();
    await expect(page.getByText("partial.bin", { exact: true })).toBeVisible();
    const activeSessionUrl = page.url();
    await page.screenshot({ fullPage: true, path: testInfo.outputPath("active-turn-primary.png") });

    const secondPage = await page.context().newPage();
    try {
        await secondPage.goto(activeSessionUrl);
        const secondPagePartialResponse = secondPage
            .getByRole("article", { name: "Agent response" })
            .filter({ hasText: "Partial reply" });
        await expect(secondPagePartialResponse).toHaveCount(1);
        await expect(secondPagePartialResponse).toBeVisible();
        await expect(secondPage.getByText("partial.bin", { exact: true })).toBeVisible();
        await expect(secondPage.getByRole("button", { name: "Stop agent output", exact: true })).toBeVisible();
        await secondPage.screenshot({ fullPage: true, path: testInfo.outputPath("active-turn-secondary.png") });

        await secondPage.getByRole("button", { name: "Stop agent output", exact: true }).click();
        await expect(secondPage.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden();
        await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden();
        await expect(partialResponse).toHaveCount(1);
        await expect(secondPagePartialResponse).toHaveCount(1);
        await expect(partialResponse).toBeVisible();
        await expect(secondPagePartialResponse).toBeVisible();
        await secondPage.screenshot({ fullPage: true, path: testInfo.outputPath("completed-turn-secondary.png") });
    } finally {
        await secondPage.close();
    }
});
