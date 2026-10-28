import { expect, test } from "./infra/test.ts";

test.use({ runtimeAgent: { id: "settings-test", name: "Settings Agent" } });

test("Given consecutive user messages, When I hover the earlier message, Then its copy button does not overlap the next message", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();

    await page.getByRole("textbox", { name: "Message" }).fill("hold with consecutive user messages");
    await page.getByRole("button", { name: "Send message" }).click();

    const userMessages = page.getByRole("article", { name: "Your message" });
    await expect(userMessages).toHaveCount(2);
    const earlier = userMessages.nth(0);
    const next = userMessages.nth(1);
    await earlier.hover();

    const copy = earlier.getByRole("button", { name: "Copy message", exact: true });
    await expect(copy).toBeVisible();
    const messageBox = await earlier.boundingBox();
    const copyBox = await copy.boundingBox();
    const nextBox = await next.boundingBox();
    if (messageBox === null || copyBox === null || nextBox === null) {
        throw new Error("Expected the user messages and copy button to have layout boxes");
    }
    expect(copyBox.y - (messageBox.y + messageBox.height)).toBeCloseTo(4, 5);
    expect(messageBox.x + messageBox.width - (copyBox.x + copyBox.width)).toBeCloseTo(-4, 5);
    expect(nextBox.y - (copyBox.y + copyBox.height)).toBeCloseTo(4, 5);
    await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath("consecutive-user-message-spacing.png"),
    });
});
