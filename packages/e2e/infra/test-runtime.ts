import { chromium } from "playwright-core";
import { mortyFiles, mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { ANONYMOUS_CREDENTIAL_KEY_NAME } from "../../web/src/services/identity/anonymous-identity-api.ts";
import { ChatApi, jsonRequest, text } from "./chat-api.ts";
import type { E2EHarness } from "./harness.ts";
import { LocalStack } from "./local-stack.ts";
import { ControlledSetupRuntime } from "./setup-daemon.ts";
import { followSetupInstructions } from "./setup-instructions.ts";

export async function createTestRuntime(harness: E2EHarness) {
    const agentId = "claude";
    const agentName = "Codex";
    const stack = await LocalStack.create(harness);
    const runtime = new ControlledSetupRuntime({
        agentId,
        agentName,
        files: mortyFiles,
        reply: mortyReply,
        nativeSessionIds: new Set(["setup-reconnect-session"]),
    });
    const application = await stack.startPlatform();
    await stack.startChat(application);
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await harness.attachBrowser(browser, context, page);
        const chat = new ChatApi(stack.chatOrigin, harness.signal);

        const openChat = async () => {
            await page.goto(stack.chatOrigin);
            const stored = await page.waitForFunction(
                (key) => localStorage.getItem(key),
                ANONYMOUS_CREDENTIAL_KEY_NAME,
            );
            const user = await chat.useBrowserIdentity(
                JSON.parse(text(await stored.jsonValue(), "stored browser identity")),
            );
            return { botId: user.botId, projectId: user.projectId };
        };

        return {
            close: async () => {
                await runtime.disconnect();
            },
            failure: runtime.failure,
            page,
            openChat,
            createPairInstruction: async () => text((await chat.createAgentPairing()).url, "pair instruction URL"),
            openPairedChat: async () => {
                await openChat();
                const pairing = await chat.createPairing();
                await runtime.run(
                    harness.workDirectory,
                    [
                        "pair",
                        "--url",
                        text(pairing.relayUrl, "relay URL"),
                        "--pairing",
                        text(pairing.pairingId, "pairing ID"),
                        "--code",
                        text(pairing.pairingCode, "pairing code"),
                    ],
                    stack.directories.workspace,
                    harness.signal,
                );
                const paired = await chat.waitForAgent(
                    harness,
                    text(pairing.pairingId, "pairing ID"),
                    agentId,
                    agentName,
                );
                await chat.bindAgent(paired.runtimeId, agentId);
                await chat.waitForBinding(harness, agentId, agentName);
                await page.reload();
            },
            disconnectRuntime: async () => await runtime.disconnect(),
            connectUnrelatedRuntime: async () => {
                const unrelated = new ChatApi(stack.chatOrigin, harness.signal);
                await unrelated.useBrowserIdentity(
                    await jsonRequest(stack.chatOrigin, "/morty/api/identity/anonymous-users", {
                        body: {},
                        signal: harness.signal,
                    }),
                );
                const pairing = await unrelated.createPairing();
                await runtime.run(
                    harness.workDirectory,
                    [
                        "pair",
                        "--url",
                        text(pairing.relayUrl, "relay URL"),
                        "--pairing",
                        text(pairing.pairingId, "pairing ID"),
                        "--code",
                        text(pairing.pairingCode, "pairing code"),
                    ],
                    stack.directories.workspace,
                    harness.signal,
                );
                await unrelated.waitForAgent(
                    harness,
                    text(pairing.pairingId, "unrelated pairingId"),
                    agentId,
                    agentName,
                );
            },
            followInstructions: async (instructionUrl: string, sessionId?: string) => {
                const url = new URL(instructionUrl, stack.chatOrigin);
                let clockTime = Date.parse("2026-09-15T12:00:00Z");
                const result = await followSetupInstructions({
                    instructionUrl: url.href,
                    cwd: stack.directories.workspace,
                    documents: harness.workDirectory,
                    harness: agentId,
                    signal: harness.signal,
                    clock: {
                        now: () => new Date(clockTime),
                        wait: async (milliseconds, signal) => {
                            signal.throwIfAborted();
                            clockTime += milliseconds;
                        },
                    },
                    runtime,
                    sessionId,
                });
                return {
                    botId: text(result.ready.botId, "ready Bot"),
                    configuration: result.configuration,
                    events: result.events,
                    url: text(result.ready.url, "Chat URL"),
                    qrDataUrl: result.ready.qrDataUrl,
                    qrPath: result.ready.qrPath,
                    qrTextPath: result.ready.qrTextPath,
                    workspace: text(result.ready.workspace, "Runtime workspace"),
                    message: text(result.ready.message, "ready message"),
                    identity: result.identity,
                };
            },
        };
    } catch (error) {
        await runtime.disconnect();
        await browser.close();
        throw error;
    }
}
