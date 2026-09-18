import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given a paired agent, When a user expands thinking and reloads the reply, Then recorded reasoning remains readable without a working spinner", async ({
    runtime,
}, testInfo) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    await runtime.sendMessage("Explain the workspace");
    await expect(page.getByTestId(dataTestId.agentResponse)).toContainText("Explain the workspace");
    const thinking = page.getByRole("group", { name: "Agent thinking" });
    await expect(thinking).toBeVisible();
    await expect(thinking.getByText("Inspecting the workspace", { exact: true })).toBeHidden();
    await thinking.locator("summary").click();
    await expect(thinking.getByText("Inspecting the workspace", { exact: true })).toBeVisible();
    await expect(page.getByRole("status", { name: "Agent working" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("thinking-completed-desktop.png"), animations: "disabled" });
    await page.reload();
    await expect(thinking).toBeVisible();
    await thinking.locator("summary").click();
    await expect(thinking.getByText("Inspecting the workspace", { exact: true })).toHaveCount(1);
    await expect(thinking.getByText("Inspecting the workspace", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("thinking-completed-mobile.png"), animations: "disabled" });
});

test("Given an agent still thinking, When a user expands, collapses and reloads the conversation, Then thinking stays expandable with a visible working indicator", async ({
    runtime,
}, testInfo) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    const { sessionId, turnId } = await runtime.sendMessage("wait until cancelled");
    const thinking = page.getByRole("group", { name: "Agent thinking" });
    const working = page.getByRole("status", { name: "Agent working" });
    await expect(thinking).toBeVisible();
    await expect(working).toBeVisible();
    await expect(
        page.getByText("Agent updates stopped. Check your local agent or reconnect.", { exact: true }),
    ).toHaveCount(0);
    await expect(thinking.locator("summary")).toContainText("Thinking…");
    await thinking.locator("summary").click();
    await expect(thinking.getByText("Inspecting the workspace", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("thinking-active-desktop.png"), animations: "disabled" });
    await thinking.locator("summary").click();
    await expect(thinking.getByText("Inspecting the workspace", { exact: true })).toBeHidden();
    await expect(working).toBeVisible();
    await page.reload();
    await expect(working).toBeVisible();
    await expect(
        page.getByText("Agent updates stopped. Check your local agent or reconnect.", { exact: true }),
    ).toHaveCount(0);
    await thinking.locator("summary").click();
    await expect(thinking.getByText("Inspecting the workspace", { exact: true })).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("thinking-active-mobile.png"), animations: "disabled" });
    await runtime.cancelSessionTurn(sessionId, turnId);
    await expect(page.getByText("Response cancelled.", { exact: true })).toBeVisible();
    await expect(working).toHaveCount(0);
    await expect(thinking.getByText("Inspecting the workspace", { exact: true })).toBeVisible();
});

test("Given a forked native session, When a user continues it and opens thinking, Then reasoning is readable and only the active reply shows a spinner", async ({
    runtime,
}, testInfo) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    await runtime.sendMessage("Local thinking example");
    await expect(page.getByTestId(dataTestId.agentResponse)).toContainText("Local thinking example");
    await page.getByRole("button", { name: "Native Sessions", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Native Sessions", exact: true });
    await dialog.getByRole("button", { name: "Local thinking example", exact: true }).click();
    await expect(dialog.getByRole("region", { name: "Selected session preview" })).toContainText(
        "Local thinking example",
    );
    await dialog.getByRole("button", { name: "Fork", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Harness", exact: true })).toBeDisabled();
    await page.getByRole("textbox", { name: "Message" }).fill("Continue explaining");
    await page.getByRole("button", { name: "Send message" }).click();
    const messages = page.getByRole("log", { name: "Messages" });
    await expect(messages.getByLabel("Agent response").last()).toContainText("Continue explaining");
    const thinking = messages.getByRole("group", { name: "Agent thinking" });
    await thinking.locator("summary").click();
    await expect(thinking.getByText("Inspecting the workspace", { exact: true })).toBeVisible();
    await expect(messages.getByRole("status", { name: "Agent working" })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Message" }).fill("wait until cancelled");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(thinking).toHaveCount(2);
    await thinking.last().locator("summary").click();
    await expect(thinking.last().getByText("Inspecting the workspace", { exact: true })).toBeVisible();
    await expect(messages.getByRole("status", { name: "Agent working" })).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("local-thinking-active.png"), animations: "disabled" });
    const cancellation = page.waitForResponse(
        (response) => response.request().method() === "POST" && /\/turns\/[^/]+\/cancel$/u.test(response.url()),
    );
    await page.getByRole("button", { name: "Stop agent output", exact: true }).click();
    expect((await cancellation).status()).toBe(202);
    await expect(page.getByText("Response cancelled.", { exact: true })).toBeVisible();
});
