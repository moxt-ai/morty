import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { buildLocalStack } from "../../packages/e2e/infra/build.ts";
import { ChatApi } from "../../packages/e2e/infra/chat-api.ts";
import { runE2E } from "../../packages/e2e/infra/harness.ts";
import { LocalStack, repository } from "../../packages/e2e/infra/local-stack.ts";
import { followSetupInstructions } from "../../packages/e2e/infra/setup-instructions.ts";
import { dataTestId } from "../../packages/web/src/data-testid.ts";
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

        const identity = await harness.stage("open-unpaired-chat", async () => {
            const identityResponse = page.waitForResponse(
                (response) => new URL(response.url()).pathname === "/mobius-cloud/api/identity/anonymous-users",
                { timeout: harness.timeoutMilliseconds },
            );
            await page.goto(stack.chatOrigin, {
                waitUntil: "domcontentloaded",
                timeout: harness.timeoutMilliseconds,
            });
            return await chat.readBrowserIdentity(await identityResponse);
        });

        await harness.stage("follow-browser-pairing-instructions", async () => {
            const instruction = await page.getByTestId(dataTestId.pairingInstruction).inputValue();
            assert.match(instruction, /^follow /u);
            const connected = await followSetupInstructions({
                documents: harness.workDirectory,
                harness: agent.id,
                instructionUrl: instruction.slice("follow ".length),
                runtime: stack.setupRuntime(),
                signal: harness.signal,
            });
            assert.deepEqual(connected.identity, { botId: identity.botId, projectId: identity.projectId });
            assert.equal(connected.ready.botId, identity.botId);
            assert.equal(connected.ready.url, stack.chatOrigin);
            await page.reload({ waitUntil: "domcontentloaded", timeout: harness.timeoutMilliseconds });
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
            const messageBox = page.getByTestId(dataTestId.messageComposer);
            await messageBox.waitFor({ state: "visible", timeout: harness.timeoutMilliseconds });
            await page
                .getByPlaceholder("Ask me anything", { exact: true })
                .waitFor({ state: "visible", timeout: harness.timeoutMilliseconds });
            await messageBox.fill(prompt);
            const firstDownload = artifactDownload();
            await page.getByTestId(dataTestId.sendMessage).click({
                timeout: harness.timeoutMilliseconds,
            });

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
