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
                // Reach the footer through sequential keyboard navigation from the code block.
                await response.getByRole("button", { name: "Copy code" }).focus();
                await page.keyboard.press("Tab");
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

        test("Given a partial response, When I stop generation and start another turn, Then the retained response remains copyable", async ({
            runtime,
        }, testInfo) => {
            const { page } = runtime;
            await page.clock.install({ time: new Date("2026-10-28T08:00:00Z") });
            await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
            await runtime.openPairedChat();
            await page.getByRole("textbox", { name: "Message" }).fill("hold with rich content");
            await page.getByRole("button", { name: "Send message" }).click();
            const response = page
                .getByRole("article", { name: "Agent response" })
                .filter({ hasText: "Partial rich reply" });
            const copy = response.getByRole("button", { name: "Copy response", exact: true });
            await expect(response).toBeVisible();
            await expect(copy).toHaveCount(0);
            await page.screenshot({
                path: testInfo.outputPath("response-streaming.png"),
                fullPage: true,
                animations: "disabled",
            });
            await page.getByRole("button", { name: "Stop agent output" }).click();
            await expect(copy).toBeVisible();
            await expect(page.getByText("Turn stopped.", { exact: true })).toBeVisible();
            if (touch) {
                await copy.tap();
            } else {
                await copy.focus();
                await page.keyboard.press("Enter");
            }
            await expect(response.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Partial rich reply");
            await page.clock.fastForward(2100);
            await page.screenshot({
                path: testInfo.outputPath("response-stopped.png"),
                fullPage: true,
                animations: "disabled",
            });
            await page.reload();
            await expect(copy).toBeVisible();
            await page.getByRole("textbox", { name: "Message" }).fill("wait for steering");
            await page.getByRole("button", { name: "Send message" }).click();
            const next = page
                .getByRole("article", { name: "Agent response" })
                .filter({ hasText: "Waiting for steering" });
            await expect(next).toBeVisible();
            await expect(next.getByRole("button", { name: "Copy response", exact: true })).toHaveCount(0);
            await copy.click();
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Partial rich reply");
            await page.getByRole("button", { name: "Stop agent output" }).click();
            await expect(next.getByRole("button", { name: "Copy response", exact: true })).toBeVisible();
        });
    });
}
