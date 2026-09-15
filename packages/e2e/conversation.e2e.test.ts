import assert from "node:assert/strict";
import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given a paired workspace, When a user creates and reloads conversations, Then prompts and replies stay in their selected conversation", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    const conversationIds = new Set();
    for (const prompt of ["First conversation", "Second conversation"]) {
        const composer = page.getByTestId(dataTestId.messageComposer);
        await expect(composer).toBeVisible();
        const originalComposer = await composer.elementHandle();
        const originalDocument = await page.locator("html").elementHandle();
        assert.ok(originalComposer);
        assert.ok(originalDocument);
        await composer.fill(prompt);
        await page.getByTestId(dataTestId.sendMessage).click();
        await expect(page.getByTestId(dataTestId.agentResponse).first()).toContainText(prompt);
        expect(await originalDocument.evaluate((element) => element.isConnected)).toBe(true);
        expect(await originalComposer.evaluate((element) => element.isConnected)).toBe(true);
        await expect(page.getByTestId(dataTestId.userMessage).last()).toHaveText(prompt);
        const conversationId = new URL(page.url()).searchParams.get("conversationId");
        expect(conversationId).toBeTruthy();
        expect(conversationIds.has(conversationId)).toBe(false);
        conversationIds.add(conversationId);
        await originalComposer.dispose();
        await originalDocument.dispose();
        if (prompt === "First conversation") {
            await page.getByTestId(dataTestId.newConversation).click();
        }
    }
    const followUp = "Continue the second conversation";
    await page.getByTestId(dataTestId.messageComposer).fill(followUp);
    await page.getByTestId(dataTestId.sendMessage).click();
    await expect(page.getByTestId(dataTestId.agentResponse).nth(1)).toContainText(followUp);
    const savedUrl = page.url();
    await page.reload();
    await expect(page.getByTestId(dataTestId.agentResponse).nth(1)).toContainText(followUp);
    expect(page.url()).toBe(savedUrl);
    await expect(page.getByTestId(dataTestId.userMessage)).toHaveText(["Second conversation", followUp]);
    await test.step("Given a saved conversation, When read on desktop or mobile, Then opposing message silhouettes distinguish the speakers without labels", async () => {
        for (const viewport of [
            { width: 1440, height: 900 },
            { width: 390, height: 844 },
        ]) {
            await page.setViewportSize(viewport);
            const user = page.getByTestId(dataTestId.userMessage).last();
            const agent = page.getByTestId(dataTestId.agentResponse).last();
            const userStyle = await user.evaluate((element) => ({
                background: getComputedStyle(element).backgroundColor,
                left: element.getBoundingClientRect().left,
                right: element.getBoundingClientRect().right,
            }));
            const agentStyle = await agent.evaluate((element) => ({
                background: getComputedStyle(element).backgroundColor,
                left: element.getBoundingClientRect().left,
            }));
            expect(userStyle.background).not.toBe(agentStyle.background);
            expect(userStyle.left).toBeGreaterThan(agentStyle.left);
            expect(userStyle.right).toBeLessThanOrEqual(viewport.width);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        }
    });
});
