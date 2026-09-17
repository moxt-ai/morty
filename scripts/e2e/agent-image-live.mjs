import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { buildLocalStack } from "../../packages/e2e/infra/build.ts";
import { ChatApi, text } from "../../packages/e2e/infra/chat-api.ts";
import { runE2E } from "../../packages/e2e/infra/harness.ts";
import { LocalStack, repository } from "../../packages/e2e/infra/local-stack.ts";
import { FakeOpenAiProvider } from "../../third-party/mobius/tests/agent-daemon/providers/openai.ts";

export async function runAgentImageE2E({ answer, expectedTool, model, name, prepareAgent, prompt, providerOptions }) {
    await runE2E(name, async (harness) => {
        const revision = (await harness.run("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
        harness.record("mobiusChatRevision", revision);

        await using provider = await harness.stage("start-fake-llm-provider", () =>
            FakeOpenAiProvider.start(model, answer, providerOptions),
        );
        const agent = await harness.stage("prepare-agent", () => prepareAgent(harness, repository, provider));
        await buildLocalStack(harness);
        const stack = await LocalStack.create(harness, agent);
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
        const paired = await harness.stage("wait-for-agent", () =>
            chat.waitForAgent(harness, text(pairing.pairingId, "pairingId"), agent.id, agent.label),
        );
        await harness.stage("bind-agent", async () => {
            await chat.bindAgent(text(paired.runtimeId, "runtimeId"), agent.id);
            await chat.waitForBinding(harness, agent.id, agent.label);
        });

        const artifactDownload = () =>
            page.waitForResponse(
                (response) => {
                    const path = new URL(response.url()).pathname;
                    return (
                        response.request().method() === "GET" &&
                        response.status() === 200 &&
                        path.includes("/artifacts/") &&
                        path.endsWith("/content")
                    );
                },
                { timeout: harness.timeoutMilliseconds },
            );

        await harness.stage("render-agent-generated-image", async () => {
            const messageBox = page.getByLabel("Message", { exact: true });
            await messageBox.waitFor({ state: "visible", timeout: harness.timeoutMilliseconds });
            const firstDownload = artifactDownload();
            await messageBox.fill(prompt);
            await page.getByLabel("Send message", { exact: true }).click({ timeout: harness.timeoutMilliseconds });

            const image = page.getByLabel("Agent media output").locator("img");
            await image.waitFor({ state: "visible", timeout: harness.timeoutMilliseconds });
            await firstDownload;
            assert.match(await image.getAttribute("src"), /^blob:/u);
            const dimensions = await image.evaluate((element) => ({
                complete: element.complete,
                height: element.naturalHeight,
                width: element.naturalWidth,
            }));
            assert.equal(dimensions.complete, true);
            assert.ok(dimensions.height > 0 && dimensions.width > 0);

            const providerRequests = provider.diagnostics();
            harness.record("fakeLlmProviderRequests", providerRequests);
            assert.ok(providerRequests.length > 0, "The Agent did not connect to the fake LLM provider");
            assert.ok(
                providerRequests.some(
                    (request) =>
                        request.selectedTool?.kind === expectedTool.kind &&
                        request.selectedTool.name === expectedTool.name,
                ),
                `The Agent did not select the expected ${expectedTool.kind} tool ${expectedTool.name}`,
            );
            assert.ok(
                providerRequests.some((request) => request.hasToolResult),
                "The Agent did not return the image tool result to the fake LLM provider",
            );
            harness.log(`PASS ${agent.label} image tool -> artifact -> browser (${agent.description})`);
        });
    });
}
