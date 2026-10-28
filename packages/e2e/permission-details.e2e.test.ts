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
        await expect(permission.getByRole("button", { name: "Deny: No" })).toBeVisible();
        await expect(permission.getByRole("button", { name: "Stop turn" })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`permission-${width}.png`), fullPage: true });
        await permission.getByRole("button", { name: "Allow: Yes" }).click();
        const form = page.getByRole("dialog", { name: "Agent information request" });
        await form.getByRole("textbox", { name: "Branch" }).fill("feature/permissions");
        await form.getByRole("button", { name: "Continue" }).click();
        await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
            "Selected branch: feature/permissions",
        );
        await expect(permission).toBeHidden();
        await page.getByRole("textbox", { name: "Message" }).fill("request session permission");
        await page.getByRole("button", { name: "Send message" }).click();
        await expect(permission.getByRole("button", { name: "Allow: Allow for this session" })).toBeVisible();
        await expect(permission.getByRole("button", { name: "Deny: Deny for this session" })).toBeVisible();
        await expect(permission).not.toContainText("Always");
        await page.screenshot({ path: testInfo.outputPath(`session-permission-${width}.png`), fullPage: true });
        await permission.getByRole("button", { name: "Allow: Allow for this session" }).click();
        await expect(page.getByRole("article", { name: "Agent response" }).last()).toContainText(
            "Selected decision: allow-session",
        );
    });
}

for (const width of [320, 390]) {
    test(`Given a long permission title and choice at ${width}px, When I review and approve it, Then all details and decisions fit the phone width`, async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await page.setViewportSize({ width, height: 900 });
        await runtime.openPairedChat();
        await page.getByRole("textbox", { name: "Message" }).fill("request long permission");
        await page.getByRole("button", { name: "Send message" }).click();
        const permission = page.getByRole("alertdialog", { name: "Agent permission request" });
        await expect(permission).toContainText("long-directory-");
        await page.screenshot({ path: testInfo.outputPath(`long-permission-${width}.png`), fullPage: true });
        const box = await permission.boundingBox();
        if (box === null) {
            throw new Error("Expected the visible permission card");
        }
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(await permission.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        const rawInput = permission.locator("pre");
        expect(await rawInput.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
        const beforeScroll = await rawInput.evaluate((element) => element.scrollLeft);
        await rawInput.evaluate((element) => {
            element.scrollLeft = element.scrollWidth;
        });
        expect(await rawInput.evaluate((element) => element.scrollLeft)).toBeGreaterThan(beforeScroll);
        const allow = permission.getByRole("button", { name: /^Allow: Allow reading/ });
        await allow.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`long-permission-decision-${width}.png`), fullPage: true });
        await allow.click();
        const form = page.getByRole("dialog", { name: "Agent information request" });
        await form.getByRole("textbox", { name: "Branch" }).fill("feature/long-permission");
        await form.getByRole("button", { name: "Continue" }).click();
        await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
            "Selected branch: feature/long-permission",
        );
        await expect(permission).toBeHidden();
    });
}

test("Given a pending permission on a phone-height screen, When it appears, Then every decision is visible and reachable without scrolling", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await page.setViewportSize({ width: 390, height: 664 });
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("Review the verification action");
    await page.getByRole("button", { name: "Send message" }).click();
    const permission = page.getByRole("alertdialog", { name: "Agent permission request" });
    await expect(permission).toContainText("pnpm test -- --reporter=verbose");
    await page.screenshot({ path: testInfo.outputPath("phone-height-permission.png") });
    for (const name of ["Allow: Yes", "Deny: No", "Stop turn"]) {
        const decision = permission.getByRole("button", { name });
        await expect(decision).toBeInViewport({ ratio: 1 });
        // Nothing, including an edge fade, may cover the decision the user taps.
        expect(
            await decision.evaluate((element) => {
                const box = element.getBoundingClientRect();
                const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                return hit !== null && element.contains(hit);
            }),
        ).toBe(true);
    }
    await permission.getByRole("button", { name: "Allow: Yes" }).click();
    const form = page.getByRole("dialog", { name: "Agent information request" });
    await form.getByRole("textbox", { name: "Branch" }).fill("feature/phone-permission");
    await form.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
        "Selected branch: feature/phone-permission",
    );
    await expect(permission).toBeHidden();
});
