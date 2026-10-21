import { expect, test } from "./infra/test.ts";

for (const width of [1440, 390]) {
    test(`Given redeemed access at ${width}px, When I return through plain Morty addresses, Then I can chat and reload without repeating setup`, async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await page.setViewportSize({ width, height: 900 });
        const handoff = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
        await page.goto(handoff.url);
        await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
        const scope = new URL(page.url()).searchParams.get("identity");
        expect(scope).not.toBeNull();
        for (const path of ["/", "/chat"]) {
            await page.goto(new URL(path, page.url()).href);
            await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
            await expect(
                page.getByRole("heading", { name: "Continue your coding session from your phone." }),
            ).toHaveCount(0);
            await expect(page).toHaveURL((url) => url.searchParams.get("identity") === scope);
            const message = `Continue my saved access from ${path}`;
            await page.getByRole("textbox", { name: "Message" }).fill(message);
            await page.getByRole("button", { name: "Send message" }).click();
            await expect(page.getByRole("article", { name: "Agent response" })).toContainText(message);
            await page.reload();
            await expect(page.getByRole("article", { name: "Agent response" })).toContainText(message);
        }
        await page.screenshot({ path: testInfo.outputPath(`saved-access-${width}.png`), fullPage: true });
    });
}
