import { expect, test } from "./infra/test.ts";

test.use({ runtimeAgent: { id: "interaction-test", name: "Interaction Agent" } });

test.describe("composer stays pinned to the pane bottom", () => {
    // A short window forces the session pane to clip: header, title, and the
    // anchored composer cannot all fit, so the pane overflows its own box.
    test("Given a short window with a pending answer, When I tab into the composer, Then the pane never scrolls away from its top", async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await page.setViewportSize({ width: 865, height: 300 });
        await runtime.openPairedChat();
        await page.getByRole("textbox", { name: "Message" }).fill("request text answers");
        await page.getByRole("button", { name: "Send message" }).click();

        const card = page.getByRole("dialog", { name: "Agent information request" });
        await expect(card).toBeVisible();
        // Tabbing across the answer controls makes the browser reveal each one.
        await card.getByRole("button", { name: "Continue" }).focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");

        const pane = page.locator(`section[aria-label="Conversation"] section`).first();
        const composer = page.getByRole("textbox", { name: "Message" }).locator("xpath=ancestor::form[1]");
        const header = page.locator(`section[aria-label="Conversation"] header`).first();
        await page.screenshot({ animations: "disabled", path: testInfo.outputPath("after-tab.png") });

        expect(await pane.evaluate((element) => element.scrollTop)).toBe(0);
        const headerBox = await header.boundingBox();
        const paneBox = await pane.boundingBox();
        const composerBox = await composer.boundingBox();
        if (headerBox === null || paneBox === null || composerBox === null) {
            throw new Error("Expected the header, pane, and composer to have layout boxes");
        }
        // The header must stay at the pane's top edge, and the composer at its bottom.
        expect(headerBox.y - paneBox.y).toBeLessThan(2);
        expect(paneBox.y + paneBox.height - (composerBox.y + composerBox.height)).toBeLessThan(16);
    });
});
