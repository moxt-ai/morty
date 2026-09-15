import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import type { runSetup as setup } from "../../setup/src/setup.ts";
import { ChatApi, object, text } from "./chat-api.ts";
import type { E2EHarness } from "./harness.ts";
import { LocalStack, repository } from "./local-stack.ts";

function isSetupModule(value: unknown): value is { readonly runSetup: typeof setup } {
    return value !== null && typeof value === "object" && "runSetup" in value && typeof value.runSetup === "function";
}

export async function createTestRuntime(harness: E2EHarness) {
    // The stateful ACP agent implements sessions and replies without requiring
    // model-provider credentials. Chat, Platform and Runtime are real processes.
    const binary = join(harness.workDirectory, "agent.sh");
    const agent = join(repository, "third-party/mobius/e2e/fixtures/fake-acp-agent/src/cli.ts");
    await writeFile(
        binary,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '1.2.0'; exit 0; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(agent)} --agent-name OpenCode "$@"\n`,
    );
    await chmod(binary, 0o700);
    const stack = await LocalStack.create(harness, {
        binary,
        xdgConfigHome: harness.workDirectory,
        publishableKey: "pk_test_c21hc2hpbmctc3BpZGVyLTg1NzQuY2xlcmsuYWNjb3VudHMuZGV2JA",
    });
    await stack.startChat(await stack.startPlatform());
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await harness.attachBrowser(browser, context, page);
        const chat = new ChatApi(stack.chatOrigin, harness.signal);

        const openChat = async () => {
            const identity = page.waitForResponse(
                (response) => new URL(response.url()).pathname === "/mobius-cloud/api/identity/anonymous-users",
            );
            await page.goto(stack.chatOrigin);
            const user = await chat.readBrowserIdentity(await identity);
            return { botId: user.botId, projectId: user.projectId };
        };

        return {
            page,
            origin: stack.chatOrigin,
            openChat,
            openPairedChat: async () => {
                await openChat();
                const pairing = await chat.createPairing();
                await stack.startMobius(pairing);
                const paired = await chat.waitForOpenCode(harness, text(pairing.pairingId, "pairingId"));
                await chat.bindOpenCode(paired.runtimeId);
                await chat.waitForBinding(harness);
                await page.reload();
            },
            followInstructions: async (instructionUrl: string) => {
                const url = new URL(instructionUrl, stack.chatOrigin);
                const document = await fetch(url, { signal: harness.signal, redirect: "error" });
                assert.equal(document.status, 200);
                const markdown = await document.text();
                assert.ok(markdown.includes(`BASE_URL="${stack.chatOrigin}"`));
                const command = markdown.match(/^node "\$SCRIPT_DIR\/setup\.mjs" (.+)$/mu)?.[1];
                assert.ok(command);
                const args = command.split(/\s+/u).map((argument) =>
                    argument
                        .replaceAll('"', "")
                        .replaceAll("$BASE_URL", stack.chatOrigin)
                        .replaceAll("$HARNESS", "opencode")
                        .replaceAll("$TOKEN", url.searchParams.get("token") ?? ""),
                );
                const download = markdown.match(/https?:\/\/[^\s`]+\/setup\.mjs/u)?.[0];
                assert.ok(download);
                const response = await fetch(download, { signal: harness.signal, redirect: "error" });
                assert.equal(response.status, 200);
                const script = join(harness.workDirectory, "setup.mjs");
                await writeFile(script, await response.text(), { mode: 0o600 });
                const bundle: unknown = await import(pathToFileURL(script).href);
                assert.ok(isSetupModule(bundle));
                const { runSetup } = bundle;
                const events: Readonly<Record<string, unknown>>[] = [];
                mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-09-15T12:00:00Z") });
                let exitCode: number;
                try {
                    exitCode = await runSetup(args, {
                        documents: harness.workDirectory,
                        signal: harness.signal,
                        emit: (event) => events.push(event),
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
                    });
                } finally {
                    mock.timers.reset();
                }
                assert.equal(exitCode, 0, JSON.stringify(events));
                const ready = events.find((event) => event.status === "ready");
                assert.ok(ready);
                const configuration = object(
                    JSON.parse(await readFile(join(harness.workDirectory, "mobius-chat/config.json"), "utf8")),
                    "local configuration",
                );
                return {
                    botId: text(ready.botId, "ready Bot"),
                    url: text(ready.url, "Chat URL"),
                    expiresAt: ready.expiresAt,
                    identity: {
                        botId: text(configuration.bot_id, "saved Bot"),
                        projectId: text(configuration.project_id, "saved Project"),
                    },
                };
            },
        };
    } catch (error) {
        await browser.close();
        throw error;
    }
}
