import { join } from "node:path";
import { MobiusRuntimeEngine, pairMobiusRuntime } from "@moxt-ai/mobius/engine";
import { expect, test } from "@playwright/test";
import { openMobiusCliInstallation } from "../../third-party/mobius/packages/cli/src/daemon/pairing/pair-local-machine.ts";
import { CodexAppServerClient } from "../../third-party/mobius/packages/cli/src/engine/acp/harness/codex/app-server-client.ts";
import { stopProcessTree } from "../../third-party/mobius/packages/cli/src/engine/util/process/executable.ts";
import { CodexFixture } from "../../third-party/mobius/packages/cli/tests/support/agents/codex.ts";
import { FakeOpenAiProvider } from "../../third-party/mobius/packages/cli/tests/support/llm/openai.ts";
import { dataTestId } from "../web/src/data-testid.ts";
import { ANONYMOUS_CREDENTIAL_KEY_NAME } from "../web/src/services/identity/anonymous-identity-api.ts";
import { encodeIdentityScope } from "../web/src/services/identity/identity-scope-url.ts";
import { ChatApi, jsonRequest, object, text } from "./infra/chat-api.ts";
import { E2EHarness } from "./infra/harness.ts";
import { LocalStack } from "./infra/local-stack.ts";

test.use({ browserName: "webkit", isMobile: true, hasTouch: true });

// Both Codex processes and the daemon are real. Only model responses are controlled.
test("Given desktop Codex owns a conversation, When I open it in Morty and queue follow-ups, Then steering is unavailable and the queued replies complete", async ({
    page,
}, testInfo) => {
    const harness = await E2EHarness.create("codex-borrowed-steering");
    const cancellation = new AbortController();
    const signal = AbortSignal.any([harness.signal, cancellation.signal]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "BORROWED_REPLY", {
        beforeFirstText: async () => {
            if (hold) {
                entered.resolve();
                await release.promise;
            }
        },
    });
    await using codex = await CodexFixture.create(provider);
    let running: Promise<void> | undefined;
    let owner: CodexAppServerClient | undefined;
    let success = false;
    try {
        const stack = await LocalStack.create(harness);
        const application = await stack.startPlatform();
        await stack.startChat(application);
        const environment = { ...codex.environment, MOBIUS_STATE_DIRECTORY: join(harness.workDirectory, "runtime") };
        const completed = Promise.withResolvers<void>();
        owner = new CodexAppServerClient({
            command: codex.executable,
            cwd: stack.directories.workspace,
            environment,
            handlers: {
                onNotification: async (method) => {
                    if (method === "turn/completed") {
                        completed.resolve();
                    }
                },
                onServerRequest: async () => {},
            },
        });
        await owner.initialize(signal);
        const started = object(
            await owner.request(
                "thread/start",
                { cwd: stack.directories.workspace, model: "mobius-test-model" },
                signal,
            ),
            "started thread",
        );
        const threadId = text(object(started["thread"], "thread")["id"], "thread ID");
        await owner.request(
            "turn/start",
            { threadId, input: [{ type: "text", text: "Desktop conversation", text_elements: [] }] },
            signal,
        );
        await completed.promise;

        const identity = await jsonRequest(stack.chatOrigin, "/morty/api/identity/anonymous-users", {
            body: {},
            signal,
        });
        const token = text(identity["token"], "token");
        const projectId = text(identity["projectId"], "project ID");
        const userId = text(identity["userId"], "user ID");
        const botId = text(object(identity["bot"], "bot")["botId"], "bot ID");
        const chat = new ChatApi(stack.chatOrigin, signal);
        // biome-ignore lint/correctness/useHookAtTopLevel: ChatApi authentication is not a React hook.
        await chat.useBrowserIdentity({ projectId, token });
        const pairing = await chat.createPairing();
        const installation = await openMobiusCliInstallation(signal, environment);
        const paired = await pairMobiusRuntime(
            installation,
            {
                defaultWorkspace: stack.directories.workspace,
                pairingCode: text(pairing["pairingCode"], "pairing code"),
                pairingId: text(pairing["pairingId"], "pairing ID"),
                relayOrigin: text(pairing["relayUrl"], "relay URL"),
            },
            signal,
            environment,
        );
        const ready = Promise.withResolvers<void>();
        running = new MobiusRuntimeEngine(paired.config, {
            onConnectionStatus: (status) => {
                if (status === "online") {
                    ready.resolve();
                }
            },
        }).run(signal);
        void running.catch(ready.reject);
        await Promise.race([ready.promise, running]);
        const pairedAgent = await chat.readPairedAgent(text(pairing["pairingId"], "pairing ID"), "codex");
        await chat.bindAgent(pairedAgent.runtimeId, "codex");
        await page.addInitScript(
            ({ key, userId, token }) => {
                localStorage.setItem(key, JSON.stringify({ [userId]: token }));
            },
            { key: ANONYMOUS_CREDENTIAL_KEY_NAME, userId, token },
        );
        const url = new URL(stack.chatOrigin);
        url.searchParams.set("identity", encodeIdentityScope({ botId, projectId, userId }));
        await page.goto(url.href);
        await page.getByRole("button", { name: "Open Session", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Open Session" });
        await dialog.getByTestId(dataTestId.localSessionEntry).first().click();
        await dialog.getByRole("button", { name: "Open", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();

        await page.setViewportSize({ width: 390, height: 844 });
        hold = true;
        await owner.request(
            "turn/start",
            { threadId, input: [{ type: "text", text: "Owner still working", text_elements: [] }] },
            signal,
        );
        await entered.promise;
        const composer = page.getByRole("textbox", { name: "Message" });
        await composer.fill("First remote follow-up");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeVisible();
        await composer.fill("Second remote follow-up");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const steer = page.getByRole("button", { name: "Steer queued message: Second remote follow-up", exact: true });
        await expect(steer).toBeDisabled();
        await expect(
            page.getByRole("button", { name: "Delete queued message: Second remote follow-up", exact: true }),
        ).toBeEnabled();
        await page.reload();
        await expect(steer).toBeDisabled();
        await page.screenshot({ path: testInfo.outputPath("borrowed-queue.png"), fullPage: true });
        release.resolve();
        await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden();
        await expect(page.getByTestId(dataTestId.queuedMessage)).toHaveCount(0);
        await expect(
            page.getByText("The target turn finished before steering could be injected", { exact: true }),
        ).toHaveCount(0);
        const history = await owner.request("thread/read", { threadId, includeTurns: true }, signal);
        expect(JSON.stringify(history)).toContain("First remote follow-up");
        expect(JSON.stringify(history)).toContain("Second remote follow-up");
        await expect(
            page.getByRole("article", { name: "Agent response" }).filter({ hasText: "BORROWED_REPLY" }).last(),
        ).toBeVisible();
        success = true;
    } catch (cause) {
        await page.screenshot({ path: testInfo.outputPath("failure.png"), fullPage: true });
        await harness.diagnose(cause);
        throw cause;
    } finally {
        release.resolve();
        cancellation.abort();
        await running?.catch(() => undefined);
        if (owner !== undefined) {
            owner.detach();
            await stopProcessTree(owner.child());
        }
        await harness.close(success);
    }
});
