import { expect, claudeTest as test } from "./infra/test.ts";

test("Given a paired Claude Code Bot, When a user sends a prompt, Then its native Session and reply survive a page reload", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openPairedChat();

    await page.getByRole("textbox", { name: "Message" }).fill("Claude conversation");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page).toHaveURL(/\?sessionId=chat_[0-9a-f]{64}$/u);
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText("Claude conversation");

    const sessionUrl = page.url();
    await page.reload();
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.getByRole("article", { name: "Your message" })).toContainText("Claude conversation");
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText("Claude conversation");
});
