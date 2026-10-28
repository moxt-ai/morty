import { expect, test } from "./infra/test.ts";

for (const touch of [false, true]) {
    test.describe(touch ? "Touch" : "Desktop", () => {
        test.use({ contextOptions: { hasTouch: touch, viewport: { width: touch ? 390 : 1280, height: 844 } } });

        test("Given a streamed answer, When it finishes and I copy it, Then its Markdown is preserved and copying remains available after reload", async ({
            runtime,
        }, testInfo) => {
            const { page } = runtime;
            await page.clock.install({ time: new Date("2026-10-27T12:00:00Z") });
            await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
            await runtime.openPairedChat();
            await page.getByRole("textbox", { name: "Message" }).fill("hold with rich content");
            await page.getByRole("button", { name: "Send message" }).click();
            const response = page
                .getByRole("article", { name: "Agent response" })
                .filter({ hasText: "Partial rich reply" });
            await expect(response).toBeVisible();
            await expect(response.getByRole("button", { name: "Copy response", exact: true })).toHaveCount(0);
            const markdown =
                "\n\n## Result\n\n- **Ready**: [details](https://example.com)\n\n```ts\nconst value = 42;\n```";
            await runtime.continueReply("hold with rich content", {
                outcome: "complete",
                output: [{ kind: "text", text: markdown }],
            });
            const copy = response.getByRole("button", { name: "Copy response", exact: true });
            await expect(copy).toBeVisible();
            const bounds = await copy.boundingBox();
            expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44);
            expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(44);
            if (touch) {
                await copy.tap();
            } else {
                // Reach the footer through sequential keyboard navigation from the response.
                await copy.focus();
                await expect(copy).toBeFocused();
                await page.keyboard.press("Enter");
            }
            await expect(response.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`Partial rich reply${markdown}`);
            await page.screenshot({ path: testInfo.outputPath("response-copied.png"), fullPage: true });
            await page.clock.fastForward(2100);
            await expect(copy).toBeVisible();
            await page.reload();
            await expect(copy).toBeVisible();
            await copy.click();
            await expect(response.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`Partial rich reply${markdown}`);
        });
    });
}
