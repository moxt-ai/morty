import { expect, test } from "./infra/test.ts";

test("Given a linked TypeScript file, When the user opens it, Then a highlighted preview sits beside the conversation", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();

    await page.getByRole("textbox", { name: "Message" }).fill("show source file");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByRole("button", { name: "Open source" }).click();

    const messages = page.getByRole("log", { name: "Messages" });
    const preview = page.getByRole("complementary", { name: "Local file preview" });
    await expect(preview).toContainText("export function FileExplorer");
    const highlightedTokens = preview.locator('code span[style*="--sdm-c"]');
    await expect(highlightedTokens.first()).toBeVisible();
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
    const messagesBox = await messages.boundingBox();
    const previewBox = await preview.boundingBox();
    expect(messagesBox).not.toBeNull();
    expect(previewBox).not.toBeNull();
    if (messagesBox === null || previewBox === null) {
        throw new Error("Expected the conversation and preview to have browser layout boxes");
    }
    expect(previewBox.x).toBeGreaterThanOrEqual(messagesBox.x + messagesBox.width - 1);
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
