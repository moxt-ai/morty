import { expect, test } from "./infra/test.ts";

test.use({ runtimeAgent: { id: "interaction-test", name: "Interaction Agent" } });
for (const width of [1440, 390]) {
    test(`Given a pending permission at ${width}px, When the user reloads and approves the exact input, Then the agent continues with that decision`, async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await page.setViewportSize({ width, height: 900 });
        await runtime.openPairedChat();
        await page.getByRole("textbox", { name: "Message" }).fill("Review the verification action");
        await page.getByRole("button", { name: "Send message" }).click();
        const permission = page.getByRole("alertdialog", { name: "Agent permission request" });
        await expect(permission).toContainText("pnpm test -- --reporter=verbose");
        await expect(permission).toContainText("src/<entry>.ts");
        await page.reload();
        await expect(permission).toContainText("pnpm test -- --reporter=verbose");
        await expect(permission.getByRole("region", { name: "Session working directory" })).toContainText("/workspace");
        await expect(permission.getByRole("button", { name: "Deny this action: No" })).toBeVisible();
        await expect(permission.getByRole("button", { name: "Stop turn" })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`permission-${width}.png`), fullPage: true });
        await permission.getByRole("button", { name: "Allow this action: Yes" }).click();
        const form = page.getByRole("dialog", { name: "Agent information request" });
        await form.getByRole("textbox", { name: "Branch" }).fill("feature/permissions");
        await form.getByRole("button", { name: "Continue" }).click();
        await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
            "Selected branch: feature/permissions",
        );
        await expect(permission).toBeHidden();
    });
}
