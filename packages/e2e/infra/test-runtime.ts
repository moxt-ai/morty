import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mock } from "node:test";
import { chromium } from "playwright-core";
import { ANONYMOUS_CREDENTIAL_KEY_NAME } from "../../web/src/services/identity/anonymous-identity-api.ts";
import { ChatApi, jsonRequest, text } from "./chat-api.ts";
import type { E2EHarness } from "./harness.ts";
import { LocalStack, repository } from "./local-stack.ts";
import { followSetupInstructions } from "./setup-instructions.ts";

const agentProfiles = {
    claude: {
        adapterOverrideVariable: "MOBIUS_CLAUDE_ACP_PATH",
        agentOverrideVariable: "MOBIUS_CLAUDE_PATH",
        label: "Claude Code",
        nativeIdArgument: "",
        version: "2.1.278",
    },
    opencode: {
        adapterOverrideVariable: "MOBIUS_OPENCODE_PATH",
        agentOverrideVariable: null,
        label: "OpenCode",
        nativeIdArgument: "--opencode-native-id",
        version: "1.18.29",
    },
    pi: {
        adapterOverrideVariable: "MOBIUS_PI_ACP_PATH",
        agentOverrideVariable: "MOBIUS_PI_PATH",
        label: "Pi",
        nativeIdArgument: "",
        version: "0.85.0",
    },
} as const;

export async function createTestRuntime(harness: E2EHarness, agentId: keyof typeof agentProfiles = "opencode") {
    // The stateful ACP agent implements sessions and replies without requiring
    // model-provider credentials. Chat, Platform and Runtime are real processes.
    const binary = join(harness.workDirectory, "agent.sh");
    const profile = agentProfiles[agentId];
    await mkdir(join(harness.workDirectory, "agent-state"), { recursive: true });
    const agent = join(repository, "third-party/mobius/tests/agent-daemon/fixtures/fake-acp-agent/src/cli.ts");
    await writeFile(
        binary,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${profile.version}'; exit 0; fi\nexport MOBIUS_FAKE_ACP_STATE_DIRECTORY=${JSON.stringify(join(harness.workDirectory, "agent-state"))}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(agent)} --agent-name ${JSON.stringify(profile.label)} ${profile.nativeIdArgument} "$@"\n`,
    );
    await chmod(binary, 0o700);
    const stack = await LocalStack.create(harness, {
        acpBinary: binary,
        adapterOverrideVariable: profile.adapterOverrideVariable,
        description: `stateful fake ${agentId} ACP agent`,
        id: agentId,
        label: profile.label,
        publishableKey: "pk_test_c21hc2hpbmctc3BpZGVyLTg1NzQuY2xlcmsuYWNjb3VudHMuZGV2JA",
        runtimeEnvironment: profile.agentOverrideVariable === null ? {} : { [profile.agentOverrideVariable]: binary },
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
            page,
            origin: stack.chatOrigin,
            workspace: stack.directories.workspace,
            openChat,
            createPairInstruction: async () => text((await chat.createAgentPairing()).url, "pair instruction URL"),
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
            disconnectRuntime: async () => await stack.stopMobiusManager(),
            disconnectPlatform: async () => await stack.harness.terminate("mobius-platform"),
            connectUnrelatedRuntime: async () => {
                const unrelated = new ChatApi(stack.chatOrigin, harness.signal);
                await unrelated.useBrowserIdentity(
                    await jsonRequest(stack.chatOrigin, "/morty/api/identity/anonymous-users", {
                        body: {},
                        signal: harness.signal,
                    }),
                );
                const pairing = await unrelated.createPairing();
                await stack.startMobius(pairing);
                await unrelated.waitForAgent(
                    harness,
                    text(pairing.pairingId, "unrelated pairingId"),
                    stack.agent.id,
                    stack.agent.label,
                );
            },
            followInstructions: async (instructionUrl: string, sessionId?: string) => {
                const url = new URL(instructionUrl, stack.chatOrigin);
                mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-09-15T12:00:00Z") });
                try {
                    const result = await followSetupInstructions({
                        instructionUrl: url.href,
                        cwd: stack.directories.workspace,
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
                        configuration: result.configuration,
                        events: result.events,
                        url: text(result.ready.url, "Chat URL"),
                        expiresAt: result.ready.expiresAt,
                        qrPath: result.ready.qrPath,
                        qrTextPath: result.ready.qrTextPath,
                        workspace: text(result.ready.workspace, "Runtime workspace"),
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
