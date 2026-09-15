import { dataTestId } from "../web/src/data-testid.ts";
import { object, text } from "./infra/chat-api.ts";
import { expect, test } from "./infra/test.ts";

test("Given a paired agent, When a user expands thinking and reloads the reply, Then recorded reasoning remains readable without a working spinner", async ({
    runtime,
}, testInfo) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    await page.getByTestId(dataTestId.messageComposer).fill("Explain the workspace");
    await page.getByTestId(dataTestId.sendMessage).click();
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
    await page.getByTestId(dataTestId.messageComposer).fill("wait until cancelled");
    const acceptance = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === "/mobius/api/v1/client/session/turns" &&
            response.request().method() === "POST",
    );
    await page.getByTestId(dataTestId.sendMessage).click();
    const accepted: unknown = await (await acceptance).json();
    const turnId = text(object(accepted, "accepted turn").turnId, "turn ID");
    const acceptanceBody = object(accepted, "turn acceptance");
    const sessionId = text(object(acceptanceBody.turn, "accepted turn").sessionId, "session ID");
    const thinking = page.getByRole("group", { name: "Agent thinking" });
    const working = page.getByRole("status", { name: "Agent working" });
    await expect(thinking).toBeVisible();
    await expect(working).toBeVisible();
    await expect(thinking.locator("summary")).toContainText("Thinking…");
    await thinking.locator("summary").click();
    await expect(thinking.getByText("Inspecting the workspace", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("thinking-active-desktop.png"), animations: "disabled" });
    await thinking.locator("summary").click();
    await expect(thinking.getByText("Inspecting the workspace", { exact: true })).toBeHidden();
    await expect(working).toBeVisible();
    await page.reload();
    await expect(working).toBeVisible();
    await thinking.locator("summary").click();
    await expect(thinking.getByText("Inspecting the workspace", { exact: true })).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("thinking-active-mobile.png"), animations: "disabled" });
    await runtime.cancelSessionTurn(sessionId, turnId);
    await expect(page.getByText("Response cancelled.", { exact: true })).toBeVisible();
    await expect(working).toHaveCount(0);
    await expect(thinking.getByText("Inspecting the workspace", { exact: true })).toBeVisible();
});

test("Given a saved local session, When a user continues it and opens thinking, Then reasoning is readable and only the active reply shows a spinner", async ({
    runtime,
}, testInfo) => {
    await runtime.openPairedChat();
    const { page } = runtime;
    await page.getByTestId(dataTestId.messageComposer).fill("Local thinking example");
    await page.getByTestId(dataTestId.sendMessage).click();
    await expect(page.getByTestId(dataTestId.agentResponse)).toContainText("Local thinking example");
    await page.getByRole("button", { name: "Refresh local sessions" }).click();
    await page.getByRole("button", { name: "Local thinking example", exact: false }).click();
    await page.getByRole("textbox", { name: "Message local session" }).fill("Continue explaining");
    await page.getByRole("button", { name: "Send to local session" }).click();
    const messages = page.getByRole("log", { name: "Local session messages" });
    await expect(messages.getByLabel("Agent response").last()).toContainText("Continue explaining");
    const thinking = messages.getByRole("group", { name: "Agent thinking" });
    await thinking.locator("summary").click();
    await expect(thinking.getByText("Inspecting the workspace", { exact: true })).toBeVisible();
    await expect(messages.getByRole("status", { name: "Agent working" })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Message local session" }).fill("wait until cancelled");
    await page.getByRole("button", { name: "Send to local session" }).click();
    await expect(thinking).toHaveCount(2);
    await thinking.last().locator("summary").click();
    await expect(thinking.last().getByText("Inspecting the workspace", { exact: true })).toBeVisible();
    await expect(messages.getByRole("status", { name: "Agent working" })).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("local-thinking-active.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Back to Bot chat" }).click();
    await expect(page.getByRole("status", { name: "Agent working" })).toHaveCount(0);
});
