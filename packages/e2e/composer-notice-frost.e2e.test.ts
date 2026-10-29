import { writeFileSync } from "node:fs";
import { expect, test } from "./infra/test.ts";

test("Given a session pinned to its latest reply, When an unreadable attachment raises the composer notice, Then the reply tail tucks behind the notice", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    const composer = page.getByRole("textbox", { name: "Message" });
    // Fill the log past its viewport so the latest reply pins to its bottom edge,
    // where the notice floats; short conversations leave empty container space.
    for (let turn = 1; turn <= 8; turn += 1) {
        await composer.fill(`Notice tuck reply ${turn} `.repeat(12));
        await page.getByRole("button", { name: "Send message" }).click();
    }
    const article = page.getByRole("article", { name: "Agent response" }).last();
    await expect(article.getByRole("button", { name: "Copy response" })).toBeVisible();

    // A zero-byte file fails the attachment size check and raises the notice.
    const empty = testInfo.outputPath("empty.txt");
    writeFileSync(empty, "");
    await page.locator("input[aria-label='Choose attachments']").setInputFiles(empty);
    const notice = page.locator("form > div.absolute.inset-x-0");
    await expect(notice).toContainText("Files must be between 1 byte and 32 MB.");
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("notice-frost.png") });

    // The notice is frosted glass over the log: the latest reply keeps its tail
    // inside the notice box so the blur has message content behind it.
    const noticeBox = await notice.boundingBox();
    const articleBox = await article.boundingBox();
    if (noticeBox === null || articleBox === null) {
        throw new Error("Expected the notice and the latest reply to have layout boxes");
    }
    expect(articleBox.y + articleBox.height).toBeGreaterThan(noticeBox.y);
    expect(articleBox.y).toBeLessThan(noticeBox.y + noticeBox.height);
});
