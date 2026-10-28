import { expect, test } from "./infra/test.ts";

test("Given generated Agent reply content, When it is running, Then Working has at least a 12px gap after the content", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();

    await page.getByRole("textbox", { name: "Message" }).fill("interleaved compaction hold");
    await page.getByRole("button", { name: "Send message" }).click();

    const compaction = page.getByRole("group", { name: "Context compaction" });
    const working = page.getByRole("status", { name: "Agent is working" });
    await expect(compaction).toBeVisible();
    await expect(working).toBeVisible();

    const gap = await page.evaluate(() => {
        const working = document.querySelector('[data-testid="chat-working-indicator"]');
        const precedingContent = working?.parentElement?.previousElementSibling;
        if (!(working instanceof HTMLElement) || !(precedingContent instanceof HTMLElement)) {
            throw new Error("Expected Working to follow rendered agent content");
        }
        return working.getBoundingClientRect().top - precedingContent.getBoundingClientRect().bottom;
    });
    // A larger bottom margin or padding on generated content is allowed; the
    // requirement is only that Working never sits closer than 12px.
    expect(gap).toBeGreaterThanOrEqual(12);
    await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath("working-indicator-spacing.png"),
    });
});
