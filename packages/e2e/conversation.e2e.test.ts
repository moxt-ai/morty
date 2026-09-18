import assert from "node:assert/strict";
import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given a paired desktop workspace, When Chat opens, Then workspace navigation and conversation are clearly identified", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    await page.setViewportSize({ width: 1440, height: 900 });

    const workspace = page.getByRole("complementary", { name: "Workspace navigation", exact: true });
    await expect(workspace.getByRole("heading", { name: "Mobius Chat", exact: true })).toBeVisible();
    await expect(workspace.getByRole("button", { name: "New Conversation", exact: true })).toBeVisible();
    await expect(page.getByRole("log", { name: "Messages", exact: true })).toBeVisible();
    await expect(page.getByTestId(dataTestId.messageComposer)).toBeVisible();
});

test("Given a paired workspace, When a user clicks outside the attachment menu, Then it closes and can be reopened", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    const composer = page.getByTestId(dataTestId.messageComposer);
    await expect(composer).toHaveAttribute("placeholder", "Ask me anything");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    let addAttachment = page.getByRole("menuitem", { name: "Add attachment", exact: true });
    await expect(addAttachment).toBeVisible();
    await composer.click();
    await expect(addAttachment).toHaveCount(0);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    addAttachment = page.getByRole("menuitem", { name: "Add attachment", exact: true });
    const fileChooser = page.waitForEvent("filechooser");
    await addAttachment.click();
    await (await fileChooser).setFiles({
        name: "project-notes.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# Project notes\nKeep the reply brief."),
    });
    await expect(page.getByText("project-notes.md", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Configure agent", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Agent configuration", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Harness", exact: true })).toBeEnabled();
    await expect(page.getByRole("combobox", { name: "Model", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /microphone|whisper/iu })).toHaveCount(0);
});

test("Given a paired workspace, When the user composes with keyboard shortcuts, Then modified Enter inserts lines and Enter sends the prompt", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    const composer = page.getByTestId(dataTestId.messageComposer);

    await composer.fill("First line");
    await composer.press("Shift+Enter");
    await composer.type("**Second line**");
    await composer.press("Control+Enter");
    await composer.type("Third line");
    await expect(composer).toHaveValue("First line\n**Second line**\nThird line");
    await expect(page.getByTestId(dataTestId.sendMessage)).toBeEnabled();

    await composer.press("Enter");
    const sent = page.getByTestId(dataTestId.userMessage).last();
    await expect(sent).toHaveText("First line\nSecond line\nThird line");
    await expect(sent.getByText("Second line", { exact: true })).toHaveAttribute("data-streamdown", "strong");
    await expect(composer).toHaveValue("");
    await page.getByRole("button", { name: "More options", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Compact context", exact: true })).toBeVisible();
});

test("Given a normal Chat conversation, When messages are queued behind an active task, Then each message can be steered or deleted from the queue", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    const composer = page.getByTestId(dataTestId.messageComposer);

    await composer.fill("wait for steering");
    await expect(page.getByTestId(dataTestId.sendMessage)).toBeEnabled();
    await page.getByTestId(dataTestId.sendMessage).click();
    await expect(page.getByRole("button", { name: "Steer active task", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "More options", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeVisible();

    await composer.fill("focus on the public API");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const queue = page.getByRole("region", { name: "Queued messages", exact: true });
    await expect(queue.getByText("focus on the public API", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeVisible();
    await composer.fill("discard this follow-up");
    await composer.press("Enter");
    await expect(queue.getByText("discard this follow-up", { exact: true })).toBeVisible();
    await queue.getByRole("button", { name: "Delete queued message: discard this follow-up", exact: true }).click();
    await expect(queue.getByText("discard this follow-up", { exact: true })).toHaveCount(0);

    await queue.getByRole("button", { name: "Steer queued message: focus on the public API", exact: true }).click();
    await expect(page.getByTestId(dataTestId.agentResponse).last()).toContainText("Steered: focus on the public API");
});

test("Given a paired workspace, When the user shares their machine, Then Chat provides a fresh five-use QR link", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    await page.getByRole("button", { name: "Share My Machine", exact: true }).click();
    let share = page.getByRole("dialog", { name: "Share My Machine", exact: true });
    await expect(share.getByRole("img", { name: "Machine sharing QR code", exact: true })).toBeVisible();
    const firstUrl = await share.getByRole("link", { name: "Open sharing link", exact: true }).getAttribute("href");
    assert.match(firstUrl ?? "", /\/continue#code=/u);
    await expect(share.getByText(/used up to five times/iu)).toBeVisible();

    await share.getByRole("button", { name: "Close dialog", exact: true }).click();
    const browser = page.context().browser();
    assert.ok(browser);
    for (let use = 0; use < 5; use += 1) {
        const context = await browser.newContext();
        const transferred = await context.newPage();
        await transferred.goto(firstUrl ?? "");
        await transferred.getByRole("button", { name: "Use workspace", exact: true }).click();
        await expect(transferred.getByRole("main", { name: "Chat", exact: true })).toBeVisible();
        await context.close();
    }
    const exhaustedContext = await browser.newContext();
    const exhausted = await exhaustedContext.newPage();
    await exhausted.goto(firstUrl ?? "");
    await exhausted.getByRole("button", { name: "Use workspace", exact: true }).click();
    await expect(exhausted.getByRole("alert")).toHaveText(
        "This transfer link has expired or reached its five-use limit.",
    );
    await exhaustedContext.close();

    await page.getByRole("button", { name: "Share My Machine", exact: true }).click();
    share = page.getByRole("dialog", { name: "Share My Machine", exact: true });
    const secondUrl = await share.getByRole("link", { name: "Open sharing link", exact: true }).getAttribute("href");
    assert.match(secondUrl ?? "", /\/continue#code=/u);
    assert.notEqual(secondUrl, firstUrl);
});

test("Given an agent is producing a reply, When the user stops it from the composer, Then the reply is cancelled and the composer can send again", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    await runtime.sendMessage("wait until cancelled");
    const stop = page.getByRole("button", { name: "Stop agent output", exact: true });
    await expect(stop).toBeVisible();
    const cancellation = page.waitForResponse(
        (response) =>
            response.request().method() === "POST" &&
            /\/(?:client\/session|sessions\/[^/]+)\/turns\/[^/]+\/cancel$/u.test(new URL(response.url()).pathname),
    );
    await stop.click();
    expect((await cancellation).status()).toBe(202);
    await expect(page.getByText("Response cancelled.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
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
    await runtime.sendMessage("wait until cancelled");
    const latestMessage = page.getByTestId(dataTestId.userMessage).last();
    await expect(latestMessage).toBeVisible();
    const working = page.getByRole("status", { name: "Agent working", exact: true });
    await expect(working).toBeVisible();
    await expect(page.getByText("Working…", { exact: true })).toHaveCount(0);
    const workingPosition = await working.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
            centerX: bounds.left + bounds.width / 2,
            centerY: bounds.top + bounds.height / 2,
        };
    });
    const position = await latestMessage.evaluate((element) => {
        const message = element.getBoundingClientRect();
        const log = element.closest('[role="log"]')?.getBoundingClientRect();
        return {
            messageBottom: message.bottom,
            messageLeft: message.left,
            messageTop: message.top,
            logBottom: log?.bottom ?? 0,
            logTop: log?.top ?? 0,
        };
    });
    expect(position.messageTop).toBeGreaterThanOrEqual(position.logTop);
    expect(position.messageBottom).toBeLessThanOrEqual(position.logBottom);
    expect(Math.abs(workingPosition.centerX - (position.messageLeft + 4))).toBeLessThanOrEqual(1);
    expect(Math.abs(workingPosition.centerY - (position.messageBottom - 4))).toBeLessThanOrEqual(1);
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
    await page.getByRole("button", { name: "Stop agent output", exact: true }).click();
});

test("Given an active conversation already has assistant content, When the user switches away and back, Then its content remains visible", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    await runtime.sendMessage("Conversation to restore");
    await expect(page.getByTestId(dataTestId.agentResponse).last()).toContainText("Conversation to restore");

    await page.getByTestId(dataTestId.newConversation).click();
    await runtime.sendMessage("Other conversation");
    await expect(page.getByTestId(dataTestId.agentResponse).last()).toContainText("Other conversation");

    const sidebar = page.getByRole("complementary", { name: "Conversations", exact: true });
    await sidebar.getByRole("button", { name: "Conversation to restore", exact: true }).click();
    await runtime.sendMessage("wait until cancelled");
    await expect(page.getByTestId(dataTestId.agentResponse).last()).toContainText("Gathering context");
    await expect(page.getByText("Inspecting the workspace", { exact: true })).toBeVisible();

    await sidebar.getByRole("button", { name: "Other conversation", exact: true }).click();
    await sidebar.getByRole("button", { name: "Conversation to restore", exact: true }).click();
    await expect(page.getByText("This agent does not expose saved message history.", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId(dataTestId.agentResponse).last()).toContainText("Gathering context");
    await expect(page.getByText("Inspecting the workspace", { exact: true })).toBeVisible();
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
            const sidebar = page.getByRole("complementary", { name: "Conversations", exact: true });
            const originalSidebar = await sidebar.elementHandle();
            assert.ok(originalSidebar);
            await page.getByTestId(dataTestId.newConversation).click();
            expect(await originalDocument.evaluate((element) => element.isConnected)).toBe(true);
            expect(await originalSidebar.evaluate((element) => element.isConnected)).toBe(true);
            await expect(sidebar.getByTestId(dataTestId.newConversation)).toBeVisible();
            await expect(page.getByTestId(dataTestId.messageComposer)).toBeVisible();
            await originalSidebar.dispose();
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
    await test.step("Given Chat-created conversations, When the user switches sessions, Then the directory remains visible while session content loads and local sessions can be previewed and forked", async () => {
        const sidebar = page.getByRole("complementary", { name: "Conversations", exact: true });
        await expect(sidebar.getByRole("button", { name: "First conversation", exact: true })).toBeVisible();
        const originalComposer = await page.getByTestId(dataTestId.messageComposer).elementHandle();
        const originalSidebar = await sidebar.elementHandle();
        assert.ok(originalComposer);
        assert.ok(originalSidebar);
        await sidebar.getByRole("button", { name: "First conversation", exact: true }).click();
        await expect(sidebar.getByText("Loading conversations…", { exact: true })).toHaveCount(0);
        await expect(sidebar.getByRole("button", { name: "Second conversation", exact: true })).toBeVisible();
        await expect(page.getByRole("status", { name: "Switching session", exact: true })).toBeVisible();
        await expect(page.getByText(followUp, { exact: true })).toHaveCount(0);
        expect(await originalComposer.evaluate((element) => element.isConnected)).toBe(false);
        expect(await originalSidebar.evaluate((element) => element.isConnected)).toBe(true);
        await expect(page.getByTestId(dataTestId.userMessage)).toHaveText(["First conversation"]);
        await expect(page.getByRole("status", { name: "Switching session", exact: true })).toHaveCount(0);
        expect(await originalSidebar.evaluate((element) => element.isConnected)).toBe(true);
        await originalComposer.dispose();
        await originalSidebar.dispose();
        await page.getByRole("button", { name: "Native Sessions", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Native Sessions", exact: true });
        await expect(dialog.getByRole("button", { name: "Fork", exact: true })).toBeDisabled();
        await dialog.getByRole("button", { name: "First conversation", exact: true }).click();
        await expect(dialog.getByRole("region", { name: "Selected session preview" })).toContainText(
            "First conversation",
        );
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(sidebar.getByRole("button", { name: "First conversation", exact: true })).toHaveCount(1);
        await page.getByRole("button", { name: "Native Sessions", exact: true }).click();
        await dialog.getByRole("button", { name: "First conversation", exact: true }).click();
        await dialog.getByRole("button", { name: "Fork", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEnabled();
        await expect(sidebar.getByRole("button", { name: "First conversation", exact: true })).toHaveCount(2);
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Continue only the fork");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText(
            /OpenCode turn \d+: Continue only the fork/u,
        );
        await page.reload();
        await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText("First conversation");
        await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText(
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
