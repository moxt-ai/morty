import { expect, test } from "./infra/test.ts";

test("Given a paired OpenCode Bot, When a user sends a prompt, Then its native Session and reply survive a page reload", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openPairedChat();

    await page.getByRole("textbox", { name: "Message" }).fill("First conversation");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page).toHaveURL(/\?sessionId=ses_[a-zA-Z0-9]+/u);
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText("First conversation");

    const sessionUrl = page.url();
    await page.reload();
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.getByRole("article", { name: "Message from you" })).toContainText("First conversation");
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText("First conversation");
});
