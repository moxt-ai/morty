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
                const continuation = page.waitForResponse(
                    (response) =>
                        response.request().method() === "POST" &&
                        new URL(response.url()).pathname.endsWith("/continue-native-session"),
                    { timeout: harness.timeoutMilliseconds },
                );
                await page.goto(connected.ready.url, {
                    waitUntil: "domcontentloaded",
                    timeout: harness.timeoutMilliseconds,
                });
                await page.getByRole("button", { name: "Import session", exact: true }).click();
                assert.equal((await continuation).status(), 200);
                const composer = page.getByTestId(dataTestId.messageComposer);
                await composer.waitFor({
                    state: "visible",
                    timeout: harness.timeoutMilliseconds,
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
            const toolResultsBeforePrompt = provider.diagnostics().filter((request) => request.hasToolResult).length;
            const sessionIdFromUrl = new URL(page.url()).searchParams.get("sessionId");
            const messageBox = page.getByTestId(dataTestId.messageComposer);
            await messageBox.waitFor({ state: "visible", timeout: harness.timeoutMilliseconds });
            await messageBox.fill(prompt);
            const liveDownload = artifactDownload();
            const acceptedTurn = page.waitForResponse(
                (response) => {
                    const path = new URL(response.url()).pathname;
                    return (
                        response.request().method() === "POST" && response.status() === 202 && path.endsWith("/turns")
                    );
                },
                { timeout: harness.timeoutMilliseconds },
            );
            await page.getByRole("button", { name: "Send message", exact: true }).click({
                timeout: harness.timeoutMilliseconds,
            });
            const acceptedResponse = await acceptedTurn;
            const accepted = await acceptedResponse.json();
            let sessionId = sessionIdFromUrl;
            if (sessionId === null) {
                assert.ok(accepted !== null && typeof accepted === "object");
                assert.ok("turn" in accepted && accepted.turn !== null && typeof accepted.turn === "object");
                assert.ok("sessionId" in accepted.turn && typeof accepted.turn.sessionId === "string");
                sessionId = accepted.turn.sessionId;
            } else {
                assert.ok(
                    new URL(acceptedResponse.url()).pathname.includes(`/sessions/${encodeURIComponent(sessionId)}/`),
                );
            }

            await harness.waitFor(
                `${agent.label} image tool result`,
                async () => provider.diagnostics().filter((request) => request.hasToolResult).length,
                (count) => count > toolResultsBeforePrompt,
            );
            await liveDownload;

            const sessionUrl = new URL(page.url());
            sessionUrl.searchParams.set("sessionId", sessionId);
            const download = artifactDownload();
            await page.goto(sessionUrl.href, {
                waitUntil: "domcontentloaded",
                timeout: harness.timeoutMilliseconds,
            });
            assert.equal(new URL(page.url()).searchParams.get("sessionId"), sessionId);

            const image = page.locator('img[src^="blob:"]').last();
            try {
                await Promise.all([download, image.waitFor({ state: "attached", timeout: 30_000 })]);
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
