import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { ChatApi } from "./chat-api.mjs";
import { runE2E } from "./harness.mjs";
import { LocalStack, repository } from "./local-stack.mjs";

// The stateful ACP agent exercises the real browser, Chat, Platform and Runtime
// without depending on a live model provider for this navigation scenario.
await runE2E("new-conversation-e2e", async (harness) => {
    const binary = join(harness.workDirectory, "agent.sh");
    const agent = join(repository, "third-party/mobius/e2e/fixtures/fake-acp-agent/src/cli.ts");
    await writeFile(
        binary,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '1.2.0'; exit 0; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(agent)} --agent-name OpenCode "$@"\n`,
    );
    await chmod(binary, 0o700);
    const stack = await LocalStack.create(harness, {
        binary,
        xdgConfigHome: harness.workDirectory,
        publishableKey: "pk_test_c21hc2hpbmctc3BpZGVyLTg1NzQuY2xlcmsuYWNjb3VudHMuZGV2JA",
    });
    await stack.startChat(await stack.startPlatform());
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await harness.attachBrowser(browser, context, page);
    const chat = new ChatApi(stack.chatOrigin, harness.signal);
    const identity = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/mobius-cloud/api/identity/anonymous-users",
    );
    await page.goto(stack.chatOrigin);
    await chat.readBrowserIdentity(await identity);
    const pairing = await chat.createPairing();
    await stack.startMobius(pairing);
    const paired = await chat.waitForOpenCode(harness, pairing.pairingId);
    await chat.bindOpenCode(paired.runtimeId);
    await chat.waitForBinding(harness);
    await page.reload();

    await harness.stage(
        "Given a new conversation draft, When the first prompt is sent, Then the composer stays mounted and the reply appears in the same page",
        async () => {
            const conversationIds = new Set();
            for (const prompt of ["First conversation", "Second conversation"]) {
                const composer = page.getByLabel("Message", { exact: true });
                await composer.waitFor({ state: "visible" });
                const originalComposer = await composer.elementHandle();
                const originalDocument = await page.locator("html").elementHandle();
                assert.ok(originalComposer);
                assert.ok(originalDocument);
                await composer.fill(prompt);
                await page.getByLabel("Send message", { exact: true }).click();
                await page.getByLabel("Agent response").first().waitFor({ state: "visible" });
                assert.equal(await originalDocument.evaluate((element) => element.isConnected), true);
                assert.equal(await originalComposer.evaluate((element) => element.isConnected), true);
                assert.equal(await page.getByLabel("Your message").last().textContent(), prompt);
                const conversationId = new URL(page.url()).searchParams.get("conversationId");
                assert.ok(conversationId);
                assert.equal(conversationIds.has(conversationId), false);
                conversationIds.add(conversationId);
                await originalComposer.dispose();
                await originalDocument.dispose();
                if (prompt === "First conversation") {
                    await page.getByRole("button", { name: "New Conversation", exact: true }).click();
                }
            }
            await page.getByLabel("Message", { exact: true }).fill("Continue the second conversation");
            await page.getByLabel("Send message", { exact: true }).click();
            await page.getByLabel("Agent response").nth(1).waitFor({ state: "visible" });
            const savedUrl = page.url();
            await page.reload();
            await page.getByLabel("Agent response").nth(1).waitFor({ state: "visible" });
            assert.equal(page.url(), savedUrl);
            assert.deepEqual(await page.getByLabel("Your message").allTextContents(), [
                "Second conversation",
                "Continue the second conversation",
            ]);
        },
    );
    await harness.stage(
        "Given a saved conversation, When a user reads it on desktop or mobile, Then opposing message silhouettes distinguish the speakers without labels",
        async () => {
            for (const viewport of [
                { width: 1440, height: 900 },
                { width: 390, height: 844 },
            ]) {
                await page.setViewportSize(viewport);
                const user = page.getByLabel("Your message").last();
                const agent = page.getByLabel("Agent response").last();
                const userStyle = await user.evaluate((element) => ({
                    background: getComputedStyle(element).backgroundColor,
                    left: element.getBoundingClientRect().left,
                    right: element.getBoundingClientRect().right,
                }));
                const agentStyle = await agent.evaluate((element) => ({
                    background: getComputedStyle(element).backgroundColor,
                    left: element.getBoundingClientRect().left,
                }));
                assert.notEqual(userStyle.background, agentStyle.background);
                assert.ok(userStyle.left > agentStyle.left);
                assert.ok(userStyle.right <= viewport.width);
                assert.equal(
                    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
                    true,
                );
            }
            await page.screenshot({ path: join(harness.workDirectory, "chat-mobile.png"), fullPage: true });
            await page.setViewportSize({ width: 1440, height: 900 });
            await page.screenshot({ path: join(harness.workDirectory, "chat-desktop.png"), fullPage: true });
        },
    );
});
