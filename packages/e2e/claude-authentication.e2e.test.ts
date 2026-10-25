import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pairMobiusRuntime } from "@moxt-ai/mobius/runtime";
import { expect, test } from "@playwright/test";
import { openMobiusCliInstallation } from "../../third-party/mobius/packages/cli/src/daemon/pairing/pair-local-machine.ts";
import { ClaudeFixture } from "../../third-party/mobius/packages/cli/tests/support/agents/claude.ts";
import { ANONYMOUS_CREDENTIAL_KEY_NAME } from "../web/src/services/identity/anonymous-identity-api.ts";
import { encodeIdentityScope } from "../web/src/services/identity/identity-scope-url.ts";
import { ChatApi, jsonRequest, object, text } from "./infra/chat-api.ts";
import { E2EHarness } from "./infra/harness.ts";
import { LocalStack } from "./infra/local-stack.ts";

test.use({ browserName: "webkit", isMobile: true, hasTouch: true });

// The expired credentials are isolated; Claude, its adapter, and the full Chat stack are real.
test("Given Claude needs sign-in, When I send a message and retry after reloading, Then each failure appears once without diagnostic text in history", async ({
    page,
}, testInfo) => {
    const harness = await E2EHarness.create("claude-authentication");
    await using claude = await ClaudeFixture.createExpiredOAuth();
    const environment = { ...claude.environment, MOBIUS_STATE_DIRECTORY: join(harness.workDirectory, "runtime") };
    const cli = fileURLToPath(new URL("../../third-party/mobius/packages/cli/src/cli/entrypoint.ts", import.meta.url));
    let started = false;
    let success = false;
    try {
        const stack = await LocalStack.create(harness);
        const application = await stack.startPlatform();
        await stack.startChat(application);
        const identity = await jsonRequest(stack.chatOrigin, "/morty/api/identity/anonymous-users", {
            body: {},
            signal: harness.signal,
        });
        const token = text(identity["token"], "token");
        const projectId = text(identity["projectId"], "project ID");
        const userId = text(identity["userId"], "user ID");
        const botId = text(object(identity["bot"], "bot")["botId"], "bot ID");
        const chat = new ChatApi(stack.chatOrigin, harness.signal);
        // biome-ignore lint/correctness/useHookAtTopLevel: ChatApi authentication is not a React hook.
        await chat.useBrowserIdentity({ projectId, token });
        const pairing = await chat.createPairing();
        const installation = await openMobiusCliInstallation(harness.signal, environment);
        await pairMobiusRuntime(
            installation,
            {
                defaultWorkspace: stack.directories.workspace,
                pairingCode: text(pairing["pairingCode"], "pairing code"),
                pairingId: text(pairing["pairingId"], "pairing ID"),
                relayOrigin: text(pairing["relayUrl"], "relay URL"),
            },
            harness.signal,
            environment,
        );
        await harness.run(process.execPath, [cli, "start"], { env: environment });
        started = true;
        const pairedAgent = await chat.readPairedAgent(text(pairing["pairingId"], "pairing ID"), "claude");
        await chat.bindAgent(pairedAgent.runtimeId, "claude");
        await page.addInitScript(
            ({ key, userId, token }) => {
                localStorage.setItem(key, JSON.stringify({ [userId]: token }));
            },
            { key: ANONYMOUS_CREDENTIAL_KEY_NAME, userId, token },
        );
        const url = new URL(stack.chatOrigin);
        url.searchParams.set("identity", encodeIdentityScope({ botId, projectId, userId }));
        await page.goto(url.href);
        const composer = page.getByRole("textbox", { name: "Message" });
        await expect(composer).toBeEnabled();
        await composer.fill("Reply with a greeting");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByText("Claude Code needs sign-in", { exact: true })).toBeVisible();
        await expect(page.getByText("authentication_required", { exact: true })).toBeHidden();
        await expect(page.getByText("Claude Code needs sign-in", { exact: true })).toHaveCount(1);
        await expect(page.getByRole("alert").filter({ hasText: "Claude Code needs sign-in" })).toHaveCount(1);
        await expect(
            page.getByText("Failed to authenticate: OAuth session expired and could not be refreshed", { exact: true }),
        ).toHaveCount(0);
        await expect(composer).toBeEnabled();
        await composer.fill("Keep this draft until I sign in");
        await page.screenshot({ path: testInfo.outputPath("authentication-desktop.png"), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
        await expect(
            page.getByText("Failed to authenticate: OAuth session expired and could not be refreshed", { exact: true }),
        ).toHaveCount(0);
        await expect(composer).toHaveValue("Keep this draft until I sign in");
        await expect(composer).toBeEnabled();
        await composer.fill("Try the greeting again");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByText("authentication_required", { exact: true })).toHaveCount(1);
        await expect(page.getByText("Claude Code needs sign-in", { exact: true })).toHaveCount(1);
        await expect(page.getByRole("alert").filter({ hasText: "Claude Code needs sign-in" })).toHaveCount(1);
        await page.screenshot({ path: testInfo.outputPath("authentication-mobile.png"), fullPage: true });
        await composer.fill("Keep this draft until I sign in");
        await page.getByText("View steps", { exact: true }).click();
        await expect(page.getByText("Run claude,", { exact: false })).toBeVisible();
        await expect(page.getByText("authentication_required", { exact: true })).toBeHidden();
        await page.screenshot({ path: testInfo.outputPath("authentication-mobile-steps.png"), fullPage: true });
        await page.getByText("Technical details", { exact: true }).click();
        await expect(page.getByText("authentication_required", { exact: true })).toBeVisible();
        await expect(composer).toHaveValue("Keep this draft until I sign in");
        success = true;
    } catch (cause) {
        await page.screenshot({ path: testInfo.outputPath("failure.png"), fullPage: true });
        await harness.diagnose(cause);
        throw cause;
    } finally {
        try {
            if (started) {
                await harness.run(process.execPath, [cli, "quit"], { env: environment });
            }
        } finally {
            await harness.close(success);
        }
    }
});
