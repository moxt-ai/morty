import { type BrowserContextOptions, chromium, firefox, webkit } from "playwright-core";
import { mortyFiles, mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { ANONYMOUS_CREDENTIAL_KEY_NAME } from "../../web/src/services/identity/anonymous-identity-api.ts";
import { encodeIdentityScope } from "../../web/src/services/identity/identity-scope-url.ts";
import { ChatApi, jsonRequest, object, text } from "./chat-api.ts";
import type { E2EHarness } from "./harness.ts";
import { LocalStack } from "./local-stack.ts";
import { ControlledSetupRuntime } from "./setup-daemon.ts";
import { followSetupInstructions } from "./setup-instructions.ts";

export async function createTestRuntime(
    harness: E2EHarness,
    browserName: "chromium" | "firefox" | "webkit" = "chromium",
    contextOptions: BrowserContextOptions = {},
) {
    const setupClockStart = Date.parse("2026-09-15T12:00:00Z");
    let setupClockTime = setupClockStart;
    const agentId = "claude";
    const agentName = "Claude Code";
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
    const browser = await { chromium, firefox, webkit }[browserName].launch({ headless: true });
    try {
        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();
        await harness.attachBrowser(browser, context, page);
        const chat = new ChatApi(stack.chatOrigin, harness.signal);

        const openChat = async () => {
            const identity = object(
                await jsonRequest(stack.chatOrigin, "/morty/api/identity/anonymous-users", {
                    body: {},
                    signal: harness.signal,
                }),
                "anonymous identity",
            );
            const token = text(identity.token, "anonymous token");
            const projectId = text(identity.projectId, "projectId");
            const userId = text(identity.userId, "userId");
            const botId = text(object(identity.bot, "anonymous bot").botId, "botId");
            const url = new URL(stack.chatOrigin);
            url.searchParams.set("identity", encodeIdentityScope({ botId, projectId, userId }));
            await page.addInitScript(
                ({ key, raw }) => {
                    if (window === window.top) {
                        window.localStorage.setItem(key, raw);
                    }
                },
                {
                    key: ANONYMOUS_CREDENTIAL_KEY_NAME,
                    raw: JSON.stringify({ [userId]: token }),
                },
            );
            await page.goto(url.href);
            const user = await chat.useBrowserIdentity({ projectId, token });
            return { botId: user.botId, projectId: user.projectId };
        };

        return {
            close: async () => {
                await runtime.disconnect();
            },
            failure: runtime.failure,
            continueReply: runtime.continueReply,
            writeFiles: runtime.writeFiles,
            page,
            openChat,
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
                const paired = await chat.readPairedAgent(text(pairing.pairingId, "pairing ID"), agentId);
                await chat.bindAgent(paired.runtimeId, agentId);
                await chat.readBinding(agentId);
                await page.reload();
            },
            disconnectRuntime: async () => await runtime.disconnect(),
            forgetRuntimeConnections: async () => await runtime.forgetConnections(),
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
                await unrelated.readPairedAgent(text(pairing.pairingId, "unrelated pairingId"), agentId);
            },
            followInstructions: async (
                instructionUrl: string,
                sessionId?: string,
                maximumWaitMilliseconds?: number,
            ) => {
                const url = new URL(instructionUrl, stack.chatOrigin);
                setupClockTime = setupClockStart;
                const result = await followSetupInstructions({
                    instructionUrl: url.href,
                    cwd: stack.directories.workspace,
                    documents: harness.workDirectory,
                    harness: agentId,
                    signal: harness.signal,
                    clock: {
                        now: () => new Date(setupClockTime),
                        wait: async (milliseconds, signal) => {
                            signal.throwIfAborted();
                            setupClockTime += milliseconds;
                            if (
                                maximumWaitMilliseconds !== undefined &&
                                setupClockTime - setupClockStart > maximumWaitMilliseconds
                            ) {
                                throw new Error("Controlled setup exceeded its deterministic wait limit");
                            }
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
                    qrPath: typeof result.ready.qrPath === "string" ? result.ready.qrPath : null,
                    workspace: text(result.ready.workspace, "Runtime working directory"),
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
