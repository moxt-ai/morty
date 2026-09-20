import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { FakeOpenAiProvider } from "../../../third-party/mobius/tests/agent-daemon/providers/openai.ts";
import { dataTestId } from "../../web/src/data-testid.ts";
import { buildLocalStack } from "../infra/build.ts";
import { ChatApi } from "../infra/chat-api.ts";
import { runE2E } from "../infra/harness.ts";
import { LocalStack, repository } from "../infra/local-stack.ts";
import { followSetupInstructions } from "../infra/setup-instructions.ts";

export async function runAgentImageE2E({ answer, expectedTool, model, name, prepareAgent, prompt, providerOptions }) {
    await runE2E(name, async (harness) => {
        const revision = (await harness.run("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
        harness.record("mobiusChatRevision", revision);

        const resolvedAnswer = typeof answer === "function" ? answer(harness) : answer;
        const resolvedProviderOptions =
            typeof providerOptions === "function" ? providerOptions(harness) : providerOptions;
        await using provider = await harness.stage("start-fake-llm-provider", () =>
            FakeOpenAiProvider.start(model, resolvedAnswer, resolvedProviderOptions),
        );
        const agent = await harness.stage("prepare-agent", () => prepareAgent(harness, repository, provider));
        await buildLocalStack(harness);
        const stack = await LocalStack.create(harness, agent);
        const nativeSessionId =
            typeof agent.seedNativeSession === "function"
                ? await harness.stage("seed-native-session", () => agent.seedNativeSession(stack.directories.workspace))
                : undefined;
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

        await harness.stage("connect-browser-to-agent", async () => {
            if (nativeSessionId !== undefined) {
                const connected = await followSetupInstructions({
                    documents: harness.workDirectory,
                    harness: agent.id,
                    instructionUrl: new URL("/setup.md", stack.chatOrigin).href,
                    runtime: stack.setupRuntime(),
                    sessionId: nativeSessionId,
                    signal: harness.signal,
                });
                assert.equal(new URL(connected.ready.url).pathname, "/continue");
                assert.equal(new URL(connected.ready.url).searchParams.get("sessionId"), nativeSessionId);
                await page.goto(connected.ready.url, {
                    waitUntil: "domcontentloaded",
                    timeout: harness.timeoutMilliseconds,
                });
                await Promise.all([
                    page.waitForURL(
                        (url) =>
                            url.pathname === "/" &&
                            url.searchParams.get("sessionId") === nativeSessionId &&
                            url.searchParams.get("nativeSessionAction") === "import",
                        { timeout: 30_000 },
                    ),
                    page.getByRole("button", { name: "Import session", exact: true }).click(),
                ]);
                const composer = page.getByTestId(dataTestId.messageComposer);
                await composer.waitFor({
                    state: "visible",
                    timeout: 30_000,
                });
                await harness.waitFor("managed session composer readiness", () => composer.isEnabled(), Boolean);
                assert.ok(new URL(page.url()).searchParams.get("sessionId"));
                return;
            }

            const identityResponse = page.waitForResponse(
                (response) => new URL(response.url()).pathname === "/mobius-cloud/api/identity/anonymous-users",
                { timeout: harness.timeoutMilliseconds },
            );
            await page.goto(stack.chatOrigin, {
                waitUntil: "domcontentloaded",
                timeout: harness.timeoutMilliseconds,
            });
            const identity = await chat.readBrowserIdentity(await identityResponse);
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

        const artifactContentRequests = [];
        page.on("request", (request) => {
            const path = new URL(request.url()).pathname;
            if (path.includes("/artifacts/") && path.endsWith("/content")) {
                artifactContentRequests.push(`${request.method()} ${path}`);
            }
        });

        await harness.stage("render-agent-generated-image", async () => {
            const toolResultsBeforePrompt = provider.diagnostics().filter((request) => request.hasToolResult).length;
            const messageBox = page.getByTestId(dataTestId.messageComposer);
            await messageBox.waitFor({ state: "visible", timeout: harness.timeoutMilliseconds });
            await messageBox.fill(prompt);
            await page.getByRole("button", { name: "Send message", exact: true }).click({
                timeout: harness.timeoutMilliseconds,
            });
            await harness.waitFor(
                `${agent.label} image tool result`,
                async () => provider.diagnostics().filter((request) => request.hasToolResult).length,
                (count) => count > toolResultsBeforePrompt,
            );
            harness.log(`${agent.label} returned the image tool result`);
            const sessionUrl = new URL(page.url());
            await page.goto(sessionUrl.href, {
                waitUntil: "domcontentloaded",
                timeout: 30_000,
            });
            harness.log("Reloaded the managed session for persisted-image verification");

            const image = page.locator('img[src^="blob:"]').last();
            try {
                await image.waitFor({ state: "attached", timeout: 30_000 });
            } catch (error) {
                harness.record("pageTextAtImageFailure", await page.locator("body").innerText());
                throw error;
            }
            assert.equal(await page.getByText("[Image unavailable]", { exact: true }).count(), 0);
            assert.equal(await image.isVisible(), true);
            assert.match(await image.getAttribute("src"), /^blob:/u);
            const dimensions = await image.evaluate((element) => ({
                complete: element.complete,
                height: element.naturalHeight,
                width: element.naturalWidth,
            }));
            assert.equal(dimensions.complete, true);
            assert.ok(dimensions.height > 0 && dimensions.width > 0);
            assert.deepEqual(
                artifactContentRequests,
                [],
                "Agent-generated local images must be pulled from the daemon instead of uploaded to cloud artifacts",
            );

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
            harness.log(`PASS ${agent.label} image tool -> local daemon pull -> browser (${agent.description})`);
        });
    });
}
