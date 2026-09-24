import { expect, piTest as test } from "./infra/test.ts";

test("Given a paired Pi Bot, When a user sends a prompt, Then its native Session and reply survive a page reload", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openPairedChat();

    await page.getByRole("textbox", { name: "Message" }).fill("Pi conversation");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page).toHaveURL(/\?sessionId=[0-9a-f-]{36}$/iu);
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText("Pi conversation");

    const sessionUrl = page.url();
    await page.reload();
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.getByRole("article", { name: "Message from you" })).toContainText("Pi conversation");
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText("Pi conversation");
});
