import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

const machineName = "Browser test Runtime — Engineering workstation with a long machine name";
test.use({ runtimeMachineName: machineName });

for (const viewport of [
    { width: 1440, height: 900 },
    { width: 640, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 740 },
]) {
    test(`Given a paired chat at ${viewport.width}px, When the user opens a conversation, Then execution context and its full directory remain accessible`, async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await page.setViewportSize(viewport);
        await runtime.openPairedChat();
        const context = page.getByRole("region", { name: "Execution context" });
        await expect(page.getByRole("button", { name: `Switch computer, ${machineName}` })).toContainText("Online");
        await expect(context).toContainText(machineName);
        await expect(page.getByRole("status", { name: "Connection" })).toHaveText("Connected");
        await page.getByRole("textbox", { name: "Message" }).fill("Verify execution context");
        await page.getByRole("button", { name: "Send message" }).click();
        await expect(page.getByRole("article", { name: "Agent response" })).toBeVisible();
        await expect(page.getByRole("status", { name: "Connection" })).toHaveText("Connected");
        const box = await context.boundingBox();
        expect(box).not.toBeNull();
        if (box === null) {
            throw new Error("Expected visible execution context");
        }
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
        expect(box.height).toBeLessThanOrEqual(48);
        const details = context.getByRole("button", { name: "Show execution details" });
        await expect(details).toHaveAccessibleDescription(new RegExp(machineName));
        const target = await details.boundingBox();
        // The compact header uses the 24px minimum pointer target; the
        // Agent and complete directory are available in its details panel.
        expect(target?.height).toBeGreaterThanOrEqual(24);
        await details.click();
        const dialog = page.getByRole("dialog", { name: "Execution details", exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(machineName);
        await expect(dialog).toContainText("Claude Code");
        const fullPath = await dialog.getByTestId(dataTestId.executionDirectory).textContent();
        expect(fullPath).toMatch(/\/workspace$/);
        const detailBox = await dialog.boundingBox();
        if (detailBox === null) {
            throw new Error("Expected visible execution details");
        }
        expect(detailBox.x).toBeGreaterThanOrEqual(0);
        expect(detailBox.x + detailBox.width).toBeLessThanOrEqual(viewport.width);
        if (viewport.width < 640) {
            expect(detailBox.y + detailBox.height).toBe(viewport.height);
        }
        await page.screenshot({
            animations: "disabled",
            path: testInfo.outputPath(`execution-directory-${viewport.width}.png`),
        });
        await dialog.getByRole("button", { name: "Close execution details" }).click();
        await page.reload();
        await expect(context).toContainText(machineName);
        await expect(page.getByRole("status", { name: "Connection" })).toHaveText("Connected");
        await page.screenshot({
            animations: "disabled",
            path: testInfo.outputPath(`execution-context-${viewport.width}.png`),
        });
        await details.click();
        await expect(dialog).toContainText("Claude Code");
        await expect(dialog.getByTestId(dataTestId.executionDirectory)).toHaveText(fullPath ?? "missing directory");
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(details).toBeFocused();
    });
}
