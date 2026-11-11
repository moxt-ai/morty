import { join } from "node:path";
import { type BrowserContextOptions, chromium, firefox, webkit } from "playwright-core";
import { mortyFiles, mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { ANONYMOUS_CREDENTIAL_KEY_NAME } from "../../web/src/services/identity/anonymous-identity-api.ts";
import { encodeIdentityScope } from "../../web/src/services/identity/identity-scope-url.ts";
import { anonymousCreationKey, ChatApi, jsonRequest, object, text } from "./chat-api.ts";
import type { E2EHarness } from "./harness.ts";
import { LocalStack } from "./local-stack.ts";
import { ControlledSetupComputer } from "./setup-daemon.ts";
import { followSetupInstructions } from "./setup-instructions.ts";

export async function createTestComputer(
    journey: E2EHarness,
    browserName: "chromium" | "firefox" | "webkit" = "chromium",
    contextOptions: BrowserContextOptions = {},
    machineName = "Browser test Computer",
    agent: { readonly harness: string; readonly name: string } = { harness: "claude", name: "Claude Code" },
) {
    const setupClockStart = Date.parse("2026-09-15T12:00:00Z");
    let setupClockTime = setupClockStart;
    const harness = agent.harness;
    const agentName = agent.name;
    const stack = await LocalStack.create(journey);
    const computer = new ControlledSetupComputer(
        {
            harness,
            agentName,
            files: mortyFiles,
            reply: mortyReply,
            // Match Web/Worker fixtures: the daemon records the submitted
            // prompt, so this controlled Agent does not echo it again.
            echoUserMessage: true,
            sessionIds: new Set(["setup-reconnect-session"]),
        },
        machineName,
    );
    const additionalComputers: ControlledSetupComputer[] = [];
    const additionalFailure = Promise.withResolvers<never>();
    void additionalFailure.promise.catch(() => undefined);
    await stack.start();
    const browser = await { chromium, firefox, webkit }[browserName].launch({ headless: true });
    try {
        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();
        await journey.attachBrowser(browser, context, page);
        const chat = new ChatApi(stack.chatOrigin, journey.signal);

        const openChat = async () => {
            const identity = object(
                await jsonRequest(stack.chatOrigin, "/morty/api/identity/anonymous-users", {
                    body: { creationKey: anonymousCreationKey() },
                    signal: journey.signal,
                }),
                "anonymous identity",
            );
            const token = text(identity["token"], "anonymous token");
            const computerId = text(identity["computerId"], "computerId");
            const userId = text(identity["userId"], "userId");

            const url = new URL(stack.chatOrigin);
            url.searchParams.set("identity", encodeIdentityScope({ computerId, userId }));
            await page.addInitScript(
                ({ key, scope, token }) => {
                    if (window === window.top) {
                        const raw = window.localStorage.getItem(key);
                        const stored = raw === null ? { credentials: {}, computers: [] } : JSON.parse(raw);
                        window.localStorage.setItem(
                            key,
                            JSON.stringify({
                                credentials: { ...stored.credentials, [scope.userId]: token },
                                computers: [
                                    ...stored.computers.filter(
                                        (computer: { scope: { userId: string } }) =>
                                            computer.scope.userId !== scope.userId,
                                    ),
                                    { scope },
                                ],
                            }),
                        );
                    }
                },
                { key: ANONYMOUS_CREDENTIAL_KEY_NAME, scope: { computerId, userId }, token },
            );
            await page.goto(url.href);
            const user = await chat.useBrowserIdentity({ computerId, token });
            return { computerId: user.computerId };
        };

        return {
            close: async () => {
                await Promise.all([computer, ...additionalComputers].map((computer) => computer.disconnect()));
            },
            failure: Promise.race([computer.failure, additionalFailure.promise]),
            continueReply: computer.continueReply,
            writeFiles: computer.writeFiles,
            page,
            origin: stack.chatOrigin,
            openChat,
            openPairedChat: async (computerName?: string) => {
                const selectedComputer =
                    computerName === undefined
                        ? computer
                        : new ControlledSetupComputer(
                              {
                                  harness,
                                  agentName,
                                  files: mortyFiles,
                                  reply: mortyReply,
                                  echoUserMessage: true,
                              },
                              computerName,
                          );
                if (selectedComputer !== computer) {
                    additionalComputers.push(selectedComputer);
                    void selectedComputer.failure.catch(additionalFailure.reject);
                }
                await openChat();
                const pairing = await chat.createPairing();
                await selectedComputer.run(
                    journey.workDirectory,
                    [
                        "pair",
                        "--url",
                        text(pairing["relayUrl"], "relay URL"),
                        "--computer",
                        text(pairing["computerId"], "pairing ID"),
                        "--code-stdin",
                    ],
                    stack.directories.workspace,
                    journey.signal,
                    text(pairing["pairingCode"], "pairing code"),
                );
                const paired = await chat.readPairedAgent(text(pairing["computerId"], "pairing ID"), harness);
                await chat.bindAgent(paired.computerId, harness);
                await chat.readBinding(harness);
                await page.reload();
            },
            disconnectComputer: async () => await computer.disconnect(),
            restartComputer: async () => await computer.restart(),
            pauseComputer: computer.pause,
            resumeComputer: computer.resume,
            forgetComputerConnections: async () => await computer.forgetConnections(),
            connectUnrelatedComputer: async () => {
                const unrelated = new ChatApi(stack.chatOrigin, journey.signal);
                await unrelated.useBrowserIdentity(
                    await jsonRequest(stack.chatOrigin, "/morty/api/identity/anonymous-users", {
                        body: { creationKey: anonymousCreationKey() },
                        signal: journey.signal,
                    }),
                );
                const pairing = await unrelated.createPairing();
                await computer.run(
                    journey.workDirectory,
                    [
                        "pair",
                        "--url",
                        text(pairing["relayUrl"], "relay URL"),
                        "--computer",
                        text(pairing["computerId"], "pairing ID"),
                        "--code-stdin",
                    ],
                    stack.directories.workspace,
                    journey.signal,
                    text(pairing["pairingCode"], "pairing code"),
                );
                await unrelated.readPairedAgent(text(pairing["computerId"], "unrelated computerId"), harness);
            },
            followInstructions: async (
                instructionUrl: string,
                sessionId?: string,
                maximumWaitMilliseconds?: number,
                workspace?: string,
                replaceProject?: string,
            ) => {
                const url = new URL(instructionUrl, stack.chatOrigin);
                if (sessionId !== undefined && harness !== "claude") {
                    throw new Error(`No harness session variable is modeled for the ${harness} agent`);
                }
                setupClockTime = setupClockStart;
                const result = await followSetupInstructions({
                    instructionUrl: url.href,
                    cwd: workspace ?? stack.directories.workspace,
                    state: join(journey.workDirectory, "morty-state"),
                    harness,
                    signal: journey.signal,
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
                    computer,
                    ...(replaceProject === undefined ? {} : { replaceProject }),
                    // A Claude Code shell exposes its current session; the controlled peer stands in for Claude Code.
                    agentEnvironment: sessionId === undefined ? {} : { CLAUDE_CODE_SESSION_ID: sessionId },
                });
                return {
                    computerId: text(result.ready["computerId"], "ready computer"),
                    configuration: result.configuration,
                    events: result.events,
                    url: text(result.ready["url"], "Chat URL"),
                    qrPath: typeof result.ready["qrPath"] === "string" ? result.ready["qrPath"] : null,
                    workspace: text(result.ready["workspace"], "Computer working directory"),
                    message: text(result.ready["message"], "ready message"),
                    identity: result.identity,
                };
            },
        };
    } catch (error) {
        await computer.disconnect();
        await browser.close();
        throw error;
    }
}
