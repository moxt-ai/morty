import { readFile } from "node:fs/promises";
import { imagePreviewPng } from "../../tests/support/fake-daemon/image-preview.ts";
import { expect, test } from "./infra/test.ts";

const tallImage = imagePreviewPng(1600, 2400);
const smallImage = imagePreviewPng(16, 16);

test("Given a tool image is open, When the agent finishes, Then the history stays expanded and the image retains its trigger focus", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("hold image tool");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByRole("button", { name: "Show execution details" }).click();
    await page.getByRole("button", { name: "Generate image Tool succeeded" }).click();
    await page.getByRole("button", { name: "View image: Image" }).click();
    const viewer = page.getByRole("dialog", { name: "Image viewer" });
    await expect(viewer.getByRole("button", { name: "Zoom in" })).toBeEnabled();
    await runtime.continueReply("hold image tool", {
        outcome: "complete",
        output: [{ kind: "text", text: "The generated image is ready." }],
    });
    await expect(page.getByRole("button", { name: "Hide execution details", includeHidden: true })).toBeVisible();
    await expect(viewer.getByRole("img", { name: "Image" })).toBeVisible();
    await expect(viewer.getByLabel("Zoom level")).toHaveText("100%");
    await viewer.getByRole("button", { name: "Close image viewer" }).click();
    await expect(viewer).toBeHidden();
    await expect(page.getByRole("button", { name: "View image: Image" })).toBeFocused();
});

test("Given draft screenshots, When the user zooms, pans, switches and saves, Then the viewer preserves the draft and returns focus", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Compare these screenshots");
    await page.getByLabel("Choose attachments").setInputFiles([
        { name: "tall.png", mimeType: "image/png", buffer: tallImage },
        { name: "small.png", mimeType: "image/png", buffer: smallImage },
    ]);
    const trigger = page.getByRole("button", { name: "View image: tall.png" });
    await trigger.click();
    const viewer = page.getByRole("dialog", { name: "Image viewer" });
    const canvas = viewer.getByRole("region", { name: "Image canvas" });
    const image = viewer.getByRole("img", { name: "tall.png" });
    await expect(viewer.getByRole("button", { name: "Zoom in" })).toBeEnabled();
    const fitSize = await image.boundingBox();
    const canvasSize = await canvas.boundingBox();
    if (fitSize === null || canvasSize === null) {
        throw new Error("Expected an image canvas");
    }
    expect(fitSize.height).toBeLessThanOrEqual(canvasSize.height);
    expect(fitSize.width).toBeLessThan(1600);
    await page.screenshot({ path: testInfo.outputPath("image-viewer-desktop.png") });
    await image.dblclick();
    await expect(viewer.getByLabel("Zoom level")).toHaveText("100%");
    await image.dblclick();
    await expect(viewer.getByRole("button", { name: "Fit image" })).toHaveAttribute("aria-pressed", "true");
    await viewer.getByRole("button", { name: "Actual size" }).click();
    await expect(viewer.getByLabel("Zoom level")).toHaveText("100%");
    await expect(image).toHaveCSS("width", "1600px");
    expect(await canvas.evaluate((node) => node.scrollLeft)).toBe(
        await canvas.evaluate((node) => Math.max(0, Math.round((1600 - node.clientWidth) / 2))),
    );
    const scrollBefore = await canvas.evaluate((node) => node.scrollTop);
    await page.mouse.move(canvasSize.x + canvasSize.width / 2, canvasSize.y + canvasSize.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvasSize.x + canvasSize.width / 2 - 90, canvasSize.y + canvasSize.height / 2 - 120, {
        steps: 8,
    });
    await page.mouse.up();
    expect(await canvas.evaluate((node) => node.scrollTop)).toBeGreaterThan(scrollBefore);
    await expect(viewer).toBeVisible();
    const nextCenter = await canvas.evaluate((node) => ({
        left: Math.round((node.scrollLeft + node.clientWidth / 2) * 1.5 - node.clientWidth / 2),
        top: Math.round((node.scrollTop + node.clientHeight / 2) * 1.5 - node.clientHeight / 2),
    }));
    await viewer.getByRole("button", { name: "Zoom in" }).click();
    expect(await canvas.evaluate((node) => ({ left: node.scrollLeft, top: node.scrollTop }))).toEqual(nextCenter);
    await expect(viewer.getByLabel("Zoom level")).toHaveText("150%");
    await viewer.getByRole("button", { name: "Zoom out" }).click();
    await viewer.getByRole("button", { name: "Fit image" }).click();
    await viewer.getByRole("button", { name: "Next image" }).click();
    await expect(viewer.getByLabel("Zoom level")).toHaveText("100%");
    await expect(viewer.getByRole("img", { name: "small.png" })).toHaveCSS("width", "16px");
    await page.keyboard.press("ArrowLeft");
    await expect(image).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await viewer.getByRole("button", { name: "Download image" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("tall.png");
    expect(await readFile(await download.path())).toEqual(tallImage);
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(composer).toHaveValue("Compare these screenshots");
    await expect(page.getByRole("list", { name: "Attachments" }).getByRole("img")).toHaveCount(2);
    const url = page.url();
    await trigger.click();
    await page.goBack();
    await expect(viewer).toBeHidden();
    await expect(page).toHaveURL(url);
    await trigger.click();
    await expect(viewer.getByRole("button", { name: "Zoom in" })).toBeEnabled();
    await page.mouse.move(canvasSize.x + 10, canvasSize.y + 20);
    await page.mouse.down();
    await page.mouse.move(canvasSize.x + 50, canvasSize.y + 60, { steps: 20 });
    await page.mouse.up();
    await expect(viewer).toBeVisible();
    await page.mouse.click(canvasSize.x + 10, canvasSize.y + 20);
    await expect(viewer).toBeHidden();
});

test("Given a streaming local image gallery, When its source changes on disk, Then the open viewer saves the original bytes and file preview shares zoom controls", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    await runtime.writeFiles(
        new Map([["/workspace/generated-picture.png", { content: tallImage, mediaType: "image/png" }]]),
    );
    await page.getByRole("textbox", { name: "Message" }).fill("show image gallery");
    await page.getByRole("button", { name: "Send message" }).click();
    const trigger = page.getByRole("button", { name: "View image: First picture" });
    await expect(page.getByRole("button", { name: "View image: Second picture" })).toBeVisible();
    await trigger.click();
    const viewer = page.getByRole("dialog", { name: "Image viewer" });
    await expect(viewer.getByRole("button", { name: "Zoom in" })).toBeEnabled();
    const messages = page.getByRole("log", { name: "Messages" });
    const originalScroll = await messages.evaluate((node) => node.scrollTop);
    await runtime.writeFiles(
        new Map([["/workspace/generated-picture.png", { content: smallImage, mediaType: "image/png" }]]),
    );
    await runtime.continueReply("show image gallery", {
        outcome: "complete",
        output: [
            {
                kind: "text",
                text: "\n\n![Third picture](generated-picture.png)\n\n[Open picture](generated-picture.png)",
            },
        ],
    });
    await expect(viewer.getByText("1 of 2")).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await viewer.getByRole("button", { name: "Download image" }).click();
    expect(await readFile(await (await downloadPromise).path())).toEqual(tallImage);
    await viewer.getByRole("button", { name: "Next image" }).click();
    await viewer.getByRole("button", { name: "Actual size" }).click();
    await expect(viewer.getByRole("img", { name: "Second picture" })).toHaveCSS("width", "1600px");
    await viewer.getByRole("button", { name: "Close image viewer" }).click();
    await expect(page.getByRole("button", { name: "View image: Third picture" })).toBeVisible();
    await expect(trigger).toBeFocused();
    expect(await messages.evaluate((node) => node.scrollTop)).toBe(
        await messages.evaluate(
            (node, original) => Math.min(original, node.scrollHeight - node.clientHeight),
            originalScroll,
        ),
    );
    await trigger.click();
    await expect(viewer.getByText("1 of 3")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open picture", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "Local file preview" });
    await expect(preview.getByLabel("Zoom level")).toHaveText("100%");
    await preview.getByRole("button", { name: "Zoom in" }).click();
    await expect(preview.getByLabel("Zoom level")).toHaveText("150%");
    await page.screenshot({ path: testInfo.outputPath("image-file-preview.png") });
    await preview.getByRole("button", { name: "Close file preview" }).click();
});
