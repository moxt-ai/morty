import { expect, test } from "./infra/test.ts";

test("Given a paired Bot, When a user sends a prompt, Then its native Session and reply survive a page reload", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openPairedChat();

    await page.getByRole("textbox", { name: "Message" }).fill("First conversation");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page).toHaveURL(/\?sessionId=[^&#]+/u);
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText("First conversation");

    await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden();
    const sessionUrl = page.url();
    await page.reload();
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.getByRole("article", { name: "Your message" })).toContainText("First conversation");
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText("First conversation");
});
