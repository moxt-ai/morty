import { imagePreviewPng } from "../../tests/support/fake-daemon/image-preview.ts";
import { expect, test } from "./infra/test.ts";

test.use({ contextOptions: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });

test("Given a touch gallery, When the user pinches, pans and swipes at fit size, Then zooming keeps the current image and swiping advances the gallery", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    const png = imagePreviewPng(1600, 2400);
    await page.getByLabel("Choose attachments").setInputFiles([
        { name: "first.png", mimeType: "image/png", buffer: png },
        { name: "second.png", mimeType: "image/png", buffer: png },
    ]);
    await page.getByRole("button", { name: "View image: first.png" }).tap();
    const viewer = page.getByRole("dialog", { name: "Image viewer" });
    const canvas = viewer.getByRole("region", { name: "Image canvas" });
    await expect(viewer.getByRole("button", { name: "Zoom in" })).toBeEnabled();
    const fit = await viewer.getByLabel("Zoom level").textContent();
    const input = await page.context().newCDPSession(page);
    try {
        await input.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [
                { x: 150, y: 400, id: 1 },
                { x: 240, y: 400, id: 2 },
            ],
        });
        await input.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [
                { x: 60, y: 400, id: 1 },
                { x: 330, y: 400, id: 2 },
            ],
        });
        await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect(viewer.getByLabel("Zoom level")).not.toHaveText(fit ?? "");
        const top = await canvas.evaluate((node) => node.scrollTop);
        await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 290, y: 550, id: 1 }] });
        await input.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 80, y: 350, id: 1 }] });
        await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        expect(await canvas.evaluate((node) => node.scrollTop)).toBeGreaterThan(top);
        await expect(viewer.getByText("1 of 2")).toBeVisible();
        await viewer.getByRole("button", { name: "Fit image" }).tap();
        await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 300, y: 400, id: 1 }] });
        await input.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 80, y: 400, id: 1 }] });
        await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect(viewer.getByText("2 of 2")).toBeVisible();
    } finally {
        await input.detach();
    }
});
