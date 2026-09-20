import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mock } from "node:test";
import { chromium } from "playwright-core";
import { dataTestId } from "../../web/src/data-testid.ts";
import { ANONYMOUS_CREDENTIAL_KEY } from "../../web/src/services/identity/anonymous-identity-api.ts";
import { ChatApi, text } from "./chat-api.ts";
import type { E2EHarness } from "./harness.ts";
import { LocalStack, repository } from "./local-stack.ts";
import { followSetupInstructions } from "./setup-instructions.ts";

export async function createTestRuntime(harness: E2EHarness) {
    // The stateful ACP agent implements sessions and replies without requiring
    // model-provider credentials. Chat, Platform and Runtime are real processes.
    const binary = join(harness.workDirectory, "agent.sh");
    await mkdir(join(harness.workDirectory, "agent-state"), { recursive: true });
    const agent = join(repository, "third-party/mobius/e2e/fixtures/fake-acp-agent/src/cli.ts");
    await writeFile(
        binary,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '1.2.0'; exit 0; fi\nexport MOBIUS_FAKE_ACP_STATE_DIRECTORY=${JSON.stringify(join(harness.workDirectory, "agent-state"))}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(agent)} --agent-name OpenCode "$@"\n`,
    );
    await chmod(binary, 0o700);
    const stack = await LocalStack.create(harness, {
        acpBinary: binary,
        adapterOverrideVariable: "MOBIUS_OPENCODE_PATH",
        description: "stateful fake OpenCode ACP agent",
        id: "opencode",
        label: "OpenCode",
        publishableKey: "pk_test_c21hc2hpbmctc3BpZGVyLTg1NzQuY2xlcmsuYWNjb3VudHMuZGV2JA",
        runtimeEnvironment: {},
    });
    await stack.startChat(await stack.startPlatform());
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await harness.attachBrowser(browser, context, page);
        const chat = new ChatApi(stack.chatOrigin, harness.signal);

        const openChat = async () => {
            await page.goto(stack.chatOrigin);
            const stored = await page.waitForFunction((key) => localStorage.getItem(key), ANONYMOUS_CREDENTIAL_KEY);
            const user = await chat.useBrowserIdentity(
                JSON.parse(text(await stored.jsonValue(), "stored browser identity")),
            );
            return { botId: user.botId, projectId: user.projectId };
        };

        const sendMessage = async (prompt: string) => {
            await page.getByTestId(dataTestId.messageComposer).fill(prompt);
            await page.getByTestId(dataTestId.sendMessage).click();
            await page.getByTestId(dataTestId.userMessage).filter({ hasText: prompt }).last().waitFor();
        };

        return {
            page,
            origin: stack.chatOrigin,
            workspace: stack.directories.workspace,
            openChat,
            sendMessage,
            seedNativeSession: async (sessionId: string, prompt: string) => {
                await writeFile(
                    join(harness.workDirectory, "agent-state", `${encodeURIComponent(sessionId)}.json`),
                    JSON.stringify({
                        additionalDirectories: [],
                        cwd: stack.directories.workspace,
                        fastMode: false,
                        history: [
                            { messageId: "saved-user", role: "user", text: prompt },
                            { messageId: "saved-assistant", role: "assistant", text: `OpenCode turn 1: ${prompt}` },
                        ],
                        mode: "code",
                        model: "test-small",
                        reasoningEffort: "medium",
                        title: prompt,
                        turnCount: 1,
                    }),
                    { mode: 0o600 },
                );
            },
            openPairedChat: async () => {
                await openChat();
                const pairing = await chat.createPairing();
                await stack.startMobius(pairing);
                const paired = await chat.waitForAgent(
                    harness,
                    text(pairing.pairingId, "pairingId"),
                    stack.agent.id,
                    stack.agent.label,
                );
                await chat.bindAgent(paired.runtimeId, stack.agent.id);
                await chat.waitForBinding(harness, stack.agent.id, stack.agent.label);
                await page.reload();
            },
            followInstructions: async (instructionUrl: string, sessionId?: string) => {
                const url = new URL(instructionUrl, stack.chatOrigin);
                mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-09-15T12:00:00Z") });
                try {
                    const result = await followSetupInstructions({
                        instructionUrl: url.href,
                        documents: harness.workDirectory,
                        harness: stack.agent.id,
                        signal: harness.signal,
                        clock: {
                            now: () => new Date(),
                            wait: async (milliseconds, signal) => {
                                signal.throwIfAborted();
                                const waited = new Promise((resolve) => setTimeout(resolve, milliseconds));
                                mock.timers.tick(milliseconds);
                                await waited;
                                signal.throwIfAborted();
                            },
                        },
                        runtime: stack.setupRuntime(),
                        sessionId,
                    });
                    return {
                        botId: text(result.ready.botId, "ready Bot"),
                        url: text(result.ready.url, "Chat URL"),
                        expiresAt: result.ready.expiresAt,
                        qrPath: text(result.ready.qrPath, "QR path"),
                        qrTextPath: text(result.ready.qrTextPath, "terminal QR path"),
                        message: text(result.ready.message, "ready message"),
                        identity: result.identity,
                    };
                } finally {
                    mock.timers.reset();
                }
            },
        };
    } catch (error) {
        await browser.close();
        throw error;
    }
}
