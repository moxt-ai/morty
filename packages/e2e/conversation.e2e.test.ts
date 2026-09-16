import assert from "node:assert/strict";
import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given a paired workspace, When a user adds a file from the composer menu, Then the attachment and chat controls remain visible in the composer", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    const composer = page.getByTestId(dataTestId.messageComposer);
    await expect(composer).toHaveAttribute("placeholder", "Ask me anything");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const addAttachment = page.getByRole("menuitem", { name: "Add attachment", exact: true });
    await expect(addAttachment).toBeVisible();
    const fileChooser = page.waitForEvent("filechooser");
    await addAttachment.click();
    await (await fileChooser).setFiles({
        name: "project-notes.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# Project notes\nKeep the reply brief."),
    });
    await expect(page.getByText("project-notes.md", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Model", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /microphone|whisper/iu })).toHaveCount(0);
});

test("Given a full message viewport, When the user sends another prompt, Then the new turn is brought into view", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    await page.setViewportSize({ width: 390, height: 600 });
    const tallPrompt = Array.from({ length: 40 }, (_, index) => `Context line ${index.toString()}`).join("\n");
    await runtime.sendMessage(tallPrompt);
    await expect(page.getByTestId(dataTestId.agentResponse)).toContainText("Context line 39");
    const pagedEventRequests: string[] = [];
    page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/client/session/events") && url.searchParams.has("limit")) {
            pagedEventRequests.push(url.href);
        }
    });
    await page.reload();
    await expect(page.getByTestId(dataTestId.agentResponse)).toContainText("Context line 39");
    expect(pagedEventRequests).toEqual([]);
    const messages = page.getByRole("log", { name: "Messages", exact: true });
    const latestResponse = page.getByTestId(dataTestId.agentResponse).last();
    const responsePosition = await latestResponse.evaluate((element) => {
        const response = element.getBoundingClientRect();
        const log = element.closest('[role="log"]')?.getBoundingClientRect();
        return {
            logBottom: log?.bottom ?? 0,
            logTop: log?.top ?? 0,
            responseBottom: response.bottom,
            responseTop: response.top,
        };
    });
    expect(responsePosition.responseBottom).toBeGreaterThanOrEqual(responsePosition.logTop);
    expect(responsePosition.responseBottom).toBeLessThanOrEqual(responsePosition.logBottom);
    await messages.evaluate((element) => {
        element.scrollTop = 0;
    });
    const pending = await runtime.sendMessage("wait until cancelled");
    const latestMessage = page.getByTestId(dataTestId.userMessage).last();
    await expect(latestMessage).toBeVisible();
    await expect(page.getByRole("status", { name: "Agent working", exact: true })).toBeVisible();
    const position = await latestMessage.evaluate((element) => {
        const message = element.getBoundingClientRect();
        const log = element.closest('[role="log"]')?.getBoundingClientRect();
        return {
            messageBottom: message.bottom,
            messageTop: message.top,
            logBottom: log?.bottom ?? 0,
            logTop: log?.top ?? 0,
        };
    });
    expect(position.messageTop).toBeGreaterThanOrEqual(position.logTop);
    expect(position.messageBottom).toBeLessThanOrEqual(position.logBottom);
    await page.setViewportSize({ width: 390, height: 900 });
    const shellPosition = await page.getByRole("main", { name: "Chat", exact: true }).evaluate((element) => {
        const shell = element.getBoundingClientRect();
        return {
            documentScrollHeight: document.documentElement.scrollHeight,
            shellBottom: shell.bottom,
            shellTop: shell.top,
            viewportHeight: window.innerHeight,
        };
    });
    expect(shellPosition.shellTop).toBe(0);
    expect(shellPosition.shellBottom).toBe(shellPosition.viewportHeight);
    expect(shellPosition.documentScrollHeight).toBe(shellPosition.viewportHeight);
    await runtime.cancelSessionTurn(pending.sessionId, pending.turnId);
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
        const originalComposer = await composer.elementHandle();
        const originalDocument = await page.locator("html").elementHandle();
        assert.ok(originalComposer);
        assert.ok(originalDocument);
        await runtime.sendMessage(prompt);
        await expect(page.getByTestId(dataTestId.agentResponse).first()).toContainText(prompt);
        expect(await originalDocument.evaluate((element) => element.isConnected)).toBe(true);
        expect(await originalComposer.evaluate((element) => element.isConnected)).toBe(true);
        await expect(page.getByTestId(dataTestId.userMessage).last()).toHaveText(prompt);
        const conversationId = new URL(page.url()).searchParams.get("conversationId");
        expect(conversationId).toBeTruthy();
        expect(conversationIds.has(conversationId)).toBe(false);
        conversationIds.add(conversationId);
        if (prompt === "First conversation") {
            const sidebar = page.getByRole("complementary", { name: "Conversations", exact: true });
            const originalSidebar = await sidebar.elementHandle();
            assert.ok(originalSidebar);
            await page.getByTestId(dataTestId.newConversation).click();
            expect(await originalDocument.evaluate((element) => element.isConnected)).toBe(true);
            expect(await originalComposer.evaluate((element) => element.isConnected)).toBe(true);
            expect(await originalSidebar.evaluate((element) => element.isConnected)).toBe(true);
            await expect(sidebar.getByTestId(dataTestId.newConversation)).toBeVisible();
            await expect(page.getByTestId(dataTestId.messageComposer)).toBeVisible();
            await originalSidebar.dispose();
        }
        await originalComposer.dispose();
        await originalDocument.dispose();
    }
    const followUp = "Continue the second conversation";
    await runtime.sendMessage(followUp);
    await expect(page.getByTestId(dataTestId.agentResponse).nth(1)).toContainText(followUp);
    const savedUrl = page.url();
    const initialEventsRequest = page.waitForRequest((request) =>
        new URL(request.url()).pathname.endsWith("/client/session/events"),
    );
    await page.reload();
    expect(new URL((await initialEventsRequest).url()).searchParams.get("limit")).toBe("100");
    await expect(page.getByTestId(dataTestId.agentResponse).nth(1)).toContainText(followUp);
    expect(page.url()).toBe(savedUrl);
    await expect(page.getByTestId(dataTestId.userMessage)).toHaveText(["Second conversation", followUp]);
    await test.step("Given Chat-created conversations, When the user switches sessions, Then Chat stays mounted and local sessions can be previewed and forked", async () => {
        const sidebar = page.getByRole("complementary", { name: "Conversations", exact: true });
        await expect(sidebar.getByRole("button", { name: "First conversation", exact: true })).toBeVisible();
        const originalComposer = await page.getByTestId(dataTestId.messageComposer).elementHandle();
        const originalSidebar = await sidebar.elementHandle();
        assert.ok(originalComposer);
        assert.ok(originalSidebar);
        await sidebar.getByRole("button", { name: "First conversation", exact: true }).click();
        expect(await originalComposer.evaluate((element) => element.isConnected)).toBe(true);
        expect(await originalSidebar.evaluate((element) => element.isConnected)).toBe(true);
        await expect(page.getByText("Connecting to your agent", { exact: true })).toHaveCount(0);
        await expect(page.getByTestId(dataTestId.userMessage)).toHaveText(["First conversation"]);
        expect(await originalComposer.evaluate((element) => element.isConnected)).toBe(true);
        expect(await originalSidebar.evaluate((element) => element.isConnected)).toBe(true);
        await originalComposer.dispose();
        await originalSidebar.dispose();
        await page.getByRole("button", { name: "Open Local Session", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Open Local Session", exact: true });
        await expect(dialog.getByRole("button", { name: "Fork", exact: true })).toBeDisabled();
        await dialog.getByRole("button", { name: "First conversation", exact: true }).click();
        await expect(dialog.getByRole("region", { name: "Selected session preview" })).toContainText(
            "First conversation",
        );
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(sidebar.getByRole("button", { name: "First conversation", exact: true })).toHaveCount(1);
        await page.getByRole("button", { name: "Open Local Session", exact: true }).click();
        await dialog.getByRole("button", { name: "First conversation", exact: true }).click();
        await dialog.getByRole("button", { name: "Fork", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole("textbox", { name: "Message local session", exact: true })).toBeEnabled();
        await expect(sidebar.getByRole("button", { name: "First conversation", exact: true })).toHaveCount(2);
        await page.getByRole("textbox", { name: "Message local session", exact: true }).fill("Continue only the fork");
        await page.getByRole("button", { name: "Send to local session", exact: true }).click();
        await expect(page.getByRole("log", { name: "Local session messages", exact: true })).toContainText(
            /OpenCode turn \d+: Continue only the fork/u,
        );
        await page.reload();
        await expect(page.getByRole("log", { name: "Local session messages", exact: true })).toContainText(
            "First conversation",
        );
        await expect(page.getByRole("log", { name: "Local session messages", exact: true })).toContainText(
            /OpenCode turn \d+: Continue only the fork/u,
        );
        await sidebar
            .getByRole("button", { name: "First conversation", exact: true })
            .and(page.locator(':not([aria-current="page"])'))
            .click();
        await expect(page.getByTestId(dataTestId.userMessage)).toHaveText(["First conversation"]);
        await page.goto(savedUrl);
        await expect(page.getByTestId(dataTestId.userMessage)).toHaveText(["Second conversation", followUp]);
    });
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
    await test.step("Given a visible user message, When the user hovers and copies it, Then the message confirms it was copied", async () => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const userMessage = page.getByTestId(dataTestId.userMessage).last();
        const copy = userMessage.getByRole("button", { name: "Copy message", exact: true });
        await expect(copy).toBeHidden();
        await userMessage.hover();
        await expect(copy).toBeVisible();
        await copy.click();
        await expect(userMessage.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    });
});
