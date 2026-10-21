import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given a selected model, When the Runtime restarts, Then the conversation and new-chat preference retain that selection", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Before the Runtime restart");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText("Before the Runtime restart");

    const configuration = page.getByRole("button", { name: "Configure agent" });
    await configuration.click();
    await page.getByRole("combobox", { name: "Model" }).click();
    await page.getByTestId(dataTestId.sessionConfigValue("test-large")).click();
    await page.keyboard.press("Escape");
    await expect(configuration).toContainText("Test Large");

    // Hold automatic retry timers so recovery is observed through the visible control.
    await page.clock.install({ time: new Date("2026-10-21T07:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-21T07:00:01Z"));
    await runtime.restartRuntime();
    const retry = page.getByRole("button", { name: "Retry now" });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(composer).toBeEnabled();
    await expect(retry).toBeHidden();
    await expect(configuration).toContainText("Test Large");

    await composer.fill("After the Runtime restart");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
        page.getByRole("article", { name: "Agent response" }).filter({ hasText: "After the Runtime restart" }),
    ).toBeVisible();
    await expect(configuration).toContainText("Test Large");
    await page.screenshot({ fullPage: true, path: testInfo.outputPath("settings-after-restart.png") });

    await page.getByRole("button", { name: "New Session" }).click();
    await expect(page.getByRole("article", { name: "Agent response" })).toHaveCount(0);
    await expect(configuration).toContainText("Test Large");
    await page.reload();
    await expect(configuration).toContainText("Test Large");
    await page.screenshot({ fullPage: true, path: testInfo.outputPath("settings-new-chat-after-reload.png") });
});
