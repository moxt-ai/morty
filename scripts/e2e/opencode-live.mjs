import { chromium } from "playwright-core";
import { ChatApi, text } from "../../packages/e2e/infra/chat-api.ts";
import { runE2E } from "../../packages/e2e/infra/harness.ts";
import { LocalStack, repository } from "../../packages/e2e/infra/local-stack.ts";
import { prepareOpenCode } from "./opencode.mjs";

await runE2E("opencode-e2e", async (harness) => {
    const revision = (await harness.run("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
    harness.record("mobiusChatRevision", revision);

    const openCode = await harness.stage("prepare-opencode", () => prepareOpenCode(harness, repository));
    const stack = await LocalStack.create(harness, openCode);
    const application = await stack.startPlatform();
    await stack.startChat(application);

    const browser = await chromium.launch({
        channel: process.env.MOBIUS_E2E_BROWSER_CHANNEL ?? "chrome",
        headless: true,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await harness.attachBrowser(browser, context, page);
    const chat = new ChatApi(stack.chatOrigin, harness.signal);

    await harness.stage("create-browser-identity", async () => {
        const identityResponse = page.waitForResponse(
            (response) => new URL(response.url()).pathname === "/mobius-cloud/api/identity/anonymous-users",
            { timeout: harness.timeoutMilliseconds },
        );
        await page.goto(stack.chatOrigin, {
            waitUntil: "domcontentloaded",
            timeout: harness.timeoutMilliseconds,
        });
        await chat.readBrowserIdentity(await identityResponse);
    });

    const pairing = await harness.stage("create-runtime-pairing", () => chat.createPairing());
    await harness.stage("start-mobius", () => stack.startMobius(pairing));
    const paired = await harness.stage("wait-for-opencode", () =>
        chat.waitForOpenCode(harness, text(pairing.pairingId, "pairingId")),
    );
    await harness.stage("bind-opencode", async () => {
        await chat.bindOpenCode(text(paired.runtimeId, "runtimeId"));
        await chat.waitForBinding(harness);
    });

    await harness.stage("render-agent-response", async () => {
        const messageBox = page.getByLabel("Message", { exact: true });
        await messageBox.waitFor({ state: "visible", timeout: harness.timeoutMilliseconds });
        const marker = `OPENCODE_LIVE_E2E_${crypto.randomUUID().replaceAll("-", "")}`;
        harness.record("responseMarker", marker);
        await messageBox.fill(`Reply with exactly: ${marker}`);
        await page.getByLabel("Send message", { exact: true }).click({ timeout: harness.timeoutMilliseconds });
        await page
            .getByLabel("Agent response")
            .filter({ hasText: marker })
            .waitFor({ state: "visible", timeout: harness.timeoutMilliseconds });
        harness.log(`PASS browser -> local stack -> OpenCode (${openCode.model}) -> ${marker}`);
    });
});
