import { expect, test } from "./infra/test.ts";

const machineName = "Browser test Runtime — Engineering workstation with a long machine name";
test.use({ runtimeMachineName: machineName });

for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
]) {
    test(`Given a paired chat at ${viewport.width}px, When the user opens a conversation, Then execution context and its full directory remain accessible`, async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await page.setViewportSize(viewport);
        await runtime.openPairedChat();
        const context = page.getByRole("region", { name: "Execution context" });
        await expect(context).toContainText(machineName);
        await expect(context).toContainText("Claude Code");
        await expect(context.getByRole("status", { name: "Connection" })).toHaveText("Connected");
        await page.getByRole("textbox", { name: "Message" }).fill("Verify execution context");
        await page.getByRole("button", { name: "Send message" }).click();
        await expect(page.getByRole("article", { name: "Agent response" })).toBeVisible();
        await expect(context.getByRole("status", { name: "Connection" })).toHaveText("Connected");
        const box = await context.boundingBox();
        expect(box).not.toBeNull();
        if (box === null) {
            throw new Error("Expected visible execution context");
        }
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
        const directory = context.getByRole("button", { name: /^Working directory:/ });
        const fullPath = (await directory.getAttribute("aria-label"))?.replace("Working directory: ", "");
        await directory.click();
        const dialog = page.getByRole("dialog", { name: "Working directory", exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(fullPath ?? "missing directory");
        await page.screenshot({
            animations: "disabled",
            path: testInfo.outputPath(`execution-directory-${viewport.width}.png`),
        });
        await dialog.getByRole("button", { name: "Close dialog" }).click();
        await page.reload();
        await expect(context).toContainText("Claude Code");
        await expect(context.getByRole("status", { name: "Connection" })).toHaveText("Connected");
        await page.screenshot({
            animations: "disabled",
            path: testInfo.outputPath(`execution-context-${viewport.width}.png`),
        });
        await expect(context.getByRole("button", { name: /^Working directory:/ })).toHaveAttribute(
            "aria-label",
            `Working directory: ${fullPath}`,
        );
    });
}
