import { expect, test } from "./infra/test.ts";

test.use({ runtimeAgent: { id: "tool-lifecycle-test", name: "Tool Lifecycle Agent" } });
for (const width of [1440, 390]) {
    test(`Given a running tool at ${width}px, When I stop and reload the turn, Then unfinished tools are interrupted and later turns preserve that outcome`, async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await page.setViewportSize({ width, height: 900 });
        await runtime.openPairedChat();
        const composer = page.getByRole("textbox", { name: "Message" });
        await composer.fill("hold unfinished tools");
        await page.getByRole("button", { name: "Send message" }).click();
        await expect(page.getByLabel("Tool running", { exact: true })).toHaveCount(2);
        await composer.fill("Add another verification");
        await page.getByRole("button", { name: "Send message" }).click();
        await page.getByRole("button", { name: "Steer queued message: Add another verification" }).click();
        await expect(page.getByLabel("Tool running", { exact: true })).toHaveCount(3);
        await page.getByRole("button", { name: "Stop agent output" }).click();
        await expect(page.getByLabel("Tool interrupted", { exact: true })).toHaveCount(3);
        await expect(page.getByText("Turn stopped.", { exact: true })).toBeVisible();
        await page.reload();
        await expect(page.getByLabel("Tool running", { exact: true })).toHaveCount(0);
        await expect(page.getByLabel("Tool interrupted", { exact: true })).toHaveCount(3);
        await expect(page.getByLabel("Tool succeeded", { exact: true })).toHaveCount(1);
        await expect(page.getByLabel("Tool failed", { exact: true })).toHaveCount(1);
        await expect(page.getByText("Turn stopped.", { exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`stopped-tools-${width}.png`), fullPage: true });
        await composer.fill("complete unfinished tools");
        await page.getByRole("button", { name: "Send message" }).click();
        await expect(page.getByLabel("Tool interrupted", { exact: true })).toHaveCount(5);
        await expect(page.getByLabel("Tool running", { exact: true })).toHaveCount(0);
        await expect(page.getByText("Turn stopped.", { exact: true })).toHaveCount(1);
    });
}
