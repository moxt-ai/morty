import { expect, test } from "./infra/test.ts";

for (const width of [1440, 390]) {
    test(`Given a conversation with code at ${width}px, When I open and reload it, Then text fonts load and code uses equal-width glyphs`, async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await page.setViewportSize({ width, height: 900 });
        await runtime.openPairedChat();
        await page
            .getByRole("textbox", { name: "Message" })
            .fill("Compare `iiii` and `WWWW`.\n\n```ts\nconst value = 1;\n```");
        await page.getByRole("button", { name: "Send message" }).click();
        const reply = page.getByRole("article", { name: "Agent response" });
        await expect(reply.getByText("iiii", { exact: true })).toBeVisible();
        for (const reload of [false, true]) {
            if (reload) {
                await page.reload();
            }
            await expect(reply.getByText("iiii", { exact: true })).toBeVisible();
            const fonts = await page.evaluate(async () => {
                const requests = ["400 14px Inter", "500 14px Inter", "600 14px Inter", "400 14px RobotoMono"];
                return await Promise.all(
                    requests.map(async (font) => ({
                        font,
                        faces: (await document.fonts.load(font)).map((face) => ({
                            family: face.family,
                            status: face.status,
                        })),
                    })),
                );
            });
            for (const font of fonts) {
                expect(font.faces, font.font).not.toHaveLength(0);
                expect(
                    font.faces.every((face) => face.status === "loaded"),
                    font.font,
                ).toBe(true);
            }
            const narrow = await reply.getByText("iiii", { exact: true }).boundingBox();
            const wide = await reply.getByText("WWWW", { exact: true }).boundingBox();
            if (narrow === null || wide === null) {
                throw new Error("Code samples must be visible");
            }
            expect(Math.abs(narrow.width - wide.width)).toBeLessThan(0.1);
        }
        await page.screenshot({ path: testInfo.outputPath(`code-typography-${width}.png`), fullPage: true });
    });
}
