import { imagePreviewPng } from "../../tests/support/fake-daemon/image-preview.ts";
import { expect, test } from "./infra/test.ts";

const tallImage = imagePreviewPng(1600, 2400);
const smallImage = imagePreviewPng(16, 16);

test.use({
    browserName: "webkit",
    contextOptions: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
});
test("Given mobile draft images, When the user opens the gallery and goes Back, Then the viewer closes without leaving the chat", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("Mobile draft");
    await page.getByLabel("Choose attachments").setInputFiles([
        { name: "tall.png", mimeType: "image/png", buffer: tallImage },
        { name: "small.png", mimeType: "image/png", buffer: smallImage },
    ]);
    const url = page.url();
    await page.getByRole("button", { name: "View image: tall.png" }).tap();
    const viewer = page.getByRole("dialog", { name: "Image viewer" });
    await expect(viewer.getByRole("button", { name: "Zoom in" })).toBeEnabled();
    const bounds = await viewer.boundingBox();
    expect(bounds?.width).toBe(390);
    await page.screenshot({ path: testInfo.outputPath("image-viewer-mobile.png") });
    await viewer.getByRole("button", { name: "Actual size" }).tap();
    await expect(viewer.getByLabel("Zoom level")).toHaveText("100%");
    await viewer.getByRole("button", { name: "Next image" }).tap();
    await expect(viewer.getByRole("img", { name: "small.png" })).toBeVisible();
    await page.goBack();
    await expect(viewer).toBeHidden();
    await expect(page).toHaveURL(url);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Mobile draft");
});
