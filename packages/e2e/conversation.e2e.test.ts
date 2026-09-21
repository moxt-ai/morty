import assert from "node:assert/strict";
import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given a paired workspace, When a user works across conversations, Then session creation, queued work, replies, and revisits remain visible", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    await expect(page.getByTestId(dataTestId.botConnectionStatus)).toHaveText("Connected");
    const workingDirectory = await page.getByTestId(dataTestId.workingDirectory).textContent();
    assert.ok(workingDirectory);

    await test.step("share the machine from the unobstructed sidebar action", async () => {
        await page.getByTestId(dataTestId.shareMachine).click();
        await expect(page.getByTestId(dataTestId.machineSharing)).toBeVisible();
        await page.keyboard.press("Escape");
    });

    await page.getByTestId(dataTestId.agentConfiguration).click();
    await expect(page.getByTestId(dataTestId.agentSetting("model"))).toBeVisible();
    await expect(page.getByTestId(dataTestId.agentSetting("reasoning_effort"))).toBeVisible();
    await expect(page.getByTestId(dataTestId.agentSetting("fast_mode"))).toBeVisible();
    await page.getByTestId(dataTestId.agentConfiguration).click();

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
        await expect(page.getByTestId(dataTestId.queuedMessage)).toHaveText("First conversation");
        await expect(page.getByTestId(dataTestId.initialMessageStatus)).toHaveText("Creating session");
        await expect(page).toHaveURL(/\?conversationId=/u);
        await expect(page.getByRole("list", { name: "Attachments", exact: true })).toHaveCount(0);
        await expect(page.getByTestId(dataTestId.agentResponse).first()).toContainText("First conversation");
        await expect(page.getByTestId(dataTestId.sessionStatus)).toHaveText("Idle");
        await page.getByTestId(dataTestId.agentConfiguration).click();
        const mode = page.getByTestId(dataTestId.agentSetting("mode"));
        await expect(mode).toBeEnabled();
        await mode.click();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await expect(mode).toHaveText("Plan");
        firstConversationId = new URL(page.url()).searchParams.get("conversationId") ?? "";
        assert.notEqual(firstConversationId, "");
    });

    await test.step("create, continue, reload from daemon history, and revisit conversations", async () => {
        await page.getByTestId(dataTestId.newConversation).click();
        await expect(
            page.getByTestId(dataTestId.managedConversation).filter({ hasText: "First conversation" }),
        ).toContainText(workingDirectory);
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
        await expect(page.getByTestId(dataTestId.workingIndicator)).toContainText("Working for");
        await expect(page.getByTestId(dataTestId.workingSpinner)).toBeVisible();
        await expect(composer).toBeEnabled();
        await composer.fill("focus on the public API");
        await composer.press("Enter");
        await expect(page.getByTestId(dataTestId.queuedMessage)).toHaveText("focus on the public API");
    });
});

test("Given a new workspace, When the user enters, pairs, changes directories, and loses Runtime health, Then Chat stays visible", async ({
    runtime,
}) => {
    await runtime.openChat();
    await expect(runtime.page.getByTestId(dataTestId.chatLanding)).toBeVisible();
    await expect(runtime.page.getByTestId(dataTestId.botConnectionStatus)).toHaveText("Disconnected");
    await expect(runtime.page.getByTestId(dataTestId.pairingInstruction)).toBeVisible();
    await runtime.page.keyboard.press("Escape");

    await runtime.openPairedChat();
    const { page } = runtime;
    const directory = page.getByTestId(dataTestId.workingDirectory);
    const originalDirectory = await directory.textContent();
    assert.ok(originalDirectory);

    await directory.click();
    await expect(page.getByTestId(dataTestId.recentWorkingDirectory)).toHaveText([originalDirectory]);
    await page.getByTestId(dataTestId.changeWorkingDirectory).click();
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.getByTestId(dataTestId.workingDirectoryPath).fill("/");
    await page.clock.fastForward(1_000);
    await expect(page.getByTestId(dataTestId.workingDirectoryPreview)).toHaveAttribute("aria-label", "Folders in /");
    await page.getByTestId(dataTestId.saveWorkingDirectory).click();
    await expect(directory).toHaveText("/");

    await page.reload();
    await expect(directory).toHaveText("/");
    await directory.click();
    await expect(page.getByTestId(dataTestId.recentWorkingDirectory)).toHaveText(["/", originalDirectory]);
    await page.getByTestId(dataTestId.recentWorkingDirectory).filter({ hasText: originalDirectory }).click();
    await expect(directory).toHaveText(originalDirectory);

    await directory.click();
    await expect(page.getByTestId(dataTestId.recentWorkingDirectory)).toHaveText([originalDirectory, "/"]);
    await page.getByTestId(dataTestId.forgetRecentWorkingDirectory).nth(1).click();
    await expect(page.getByTestId(dataTestId.recentWorkingDirectory)).toHaveText([originalDirectory]);

    await page.reload();
    await directory.click();
    await expect(page.getByTestId(dataTestId.recentWorkingDirectory)).toHaveText([originalDirectory]);

    await test.step("keep Chat visible while conversation access opens", async () => {
        await page.keyboard.press("Escape");
        await runtime.sendMessage("Conversation to reopen");
        await page.reload();
        await expect(page.getByTestId(dataTestId.botConnectionStatus)).toHaveText("Connected");
    });

    await test.step("show disconnected when the Runtime WebSocket goes offline", async () => {
        await runtime.disconnectRuntime();
        await expect(page.getByTestId(dataTestId.botConnectionStatus)).toHaveText("Disconnected");
    });

    await test.step("show Runtime setup failure without replacing Chat when the user returns", async () => {
        await runtime.disconnectPlatform();
        await page.reload();
        await expect(page.getByTestId(dataTestId.botConnectionStatus)).toHaveText("Disconnected");
        await expect(page.getByTestId(dataTestId.runtimeSetupFailure)).toContainText(
            "Platform could not complete Runtime setup",
        );
    });
});
