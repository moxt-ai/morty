import assert from "node:assert/strict";
import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given a paired workspace, When a user works across conversations, Then sent images, session creation, queued work, replies, and revisits remain visible", async ({
    runtime,
}) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    await expect(page.getByTestId(dataTestId.botConnectionStatus)).toHaveText("Connected");
    const workingDirectory = await page.getByTestId(dataTestId.workingDirectory).getAttribute("title");
    assert.ok(workingDirectory);

    await test.step("share the machine from the unobstructed sidebar action", async () => {
        await page.getByTestId(dataTestId.shareMachine).click();
        await expect(page.getByTestId(dataTestId.machineSharing)).toBeVisible();
        await page.keyboard.press("Escape");
    });

    await test.step("Given model choices, When the user searches, Then only matching models remain visible", async () => {
        await page.getByTestId(dataTestId.agentConfiguration).click();
        const model = page.getByTestId(dataTestId.agentSetting("model"));
        await expect(model).toBeEnabled();
        await model.click();
        await page.getByTestId(dataTestId.modelSearch).fill("large");
        await expect(page.getByTestId(dataTestId.sessionConfigValue("test-small"))).toHaveCount(0);
        await expect(page.getByTestId(dataTestId.sessionConfigValue("test-large"))).toHaveText("Test Large");
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
    });

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
        await expect(page.getByTestId(dataTestId.recognizedReadToolCall).first()).toContainText(
            "Read package metadata",
        );
        firstConversationId = new URL(page.url()).searchParams.get("conversationId") ?? "";
        assert.notEqual(firstConversationId, "");
    });

    await test.step("create, continue, reload from daemon history, and revisit conversations", async () => {
        await page.getByTestId(dataTestId.newConversation).click();
        await expect(
            page.getByTestId(dataTestId.managedConversation).filter({ hasText: "First conversation" }),
        ).toContainText(workingDirectory);
        await runtime.sendMessage("Second conversation");
        await expect(page.getByTestId(dataTestId.agentResponse).first()).toContainText("Second conversation");
        const secondConversationId = new URL(page.url()).searchParams.get("conversationId");
        assert.ok(secondConversationId);
        expect(secondConversationId).not.toBe(firstConversationId);
        await page.reload();
        await expect(page.getByTestId(dataTestId.agentResponse).first()).toContainText("Second conversation");

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

        const firstConversation = page
            .getByTestId(dataTestId.managedConversation)
            .filter({ hasText: "First conversation" });
        await firstConversation.click({ button: "right" });
        await page.getByTestId(dataTestId.archiveConversation).click();
        await expect(firstConversation).toHaveCount(0);
    });

    await test.step("reconcile completed native history when live content is absent", async () => {
        await page.getByTestId(dataTestId.newConversation).click();
        await runtime.sendMessage("Establish live session");
        await expect(page.getByTestId(dataTestId.agentResponse).last()).toContainText(
            "OpenCode turn 1: Establish live session",
        );
        await runtime.sendMessage("recover completed native history");
        await expect(page.getByTestId(dataTestId.agentResponse).last()).toContainText(
            "OpenCode turn 2: recover completed native history",
        );
    });

    await test.step("queue a follow-up while the agent is working", async () => {
        await page.getByTestId(dataTestId.newConversation).click();
        await runtime.sendMessage("Prepare for an image prompt");
        const composer = page.getByTestId(dataTestId.messageComposer);
        const send = page.getByTestId(dataTestId.sendMessage);
        await composer.evaluate((element) => {
            const bytes = Uint8Array.from(
                atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
                (character) => character.charCodeAt(0),
            );
            const clipboard = new DataTransfer();
            clipboard.items.add(new File([bytes], "sent-image.png", { type: "image/png" }));
            element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: clipboard }));
        });
        await composer.fill("wait for steering");
        await send.click();
        await expect(page.getByTestId(dataTestId.userMessageImage)).toHaveAttribute("alt", "sent-image.png");
        await expect(send).toHaveAttribute("aria-label", "Stop agent output");
        await expect(page.getByTestId(dataTestId.workingIndicator)).toContainText("Working for");
        await expect(page.getByTestId(dataTestId.workingSpinner)).toBeVisible();
        await expect(page.getByTestId(dataTestId.agentResponse).last()).toContainText("Inspecting the workspace");
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
