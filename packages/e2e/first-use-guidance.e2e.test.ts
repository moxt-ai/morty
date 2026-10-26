import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

for (const viewport of [
    { name: "desktop", width: 1280, height: 720 },
    { name: "mobile", width: 390, height: 844 },
]) {
    test.describe(`First use on ${viewport.name}`, () => {
        test.use({
            contextOptions: {
                viewport: { width: viewport.width, height: viewport.height },
                isMobile: viewport.name === "mobile",
                hasTouch: viewport.name === "mobile",
            },
        });

        test("Given a new visitor, When they connect their original session and continue their work, Then guidance explains each step and leaves them in control", async ({
            runtime,
        }, testInfo) => {
            const { page } = runtime;
            await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
            await page.goto(runtime.origin);
            const copy = page.getByRole("button", { name: "Copy setup prompt" });
            await expect(copy).toBeInViewport();
            await expect(page.getByRole("heading", { name: "Just one prompt." })).toBeVisible();
            await expect(page.getByText("Connect your agent. Continue from any browser.")).toBeVisible();
            await expect(page.getByText("Paste the prompt into the agent on your computer.")).toBeVisible();
            await expect(page.getByRole("figure")).toHaveCount(0);
            await expect(page.getByRole("heading")).toHaveCount(1);
            const details = page.getByText("View setup prompt", { exact: true });
            const setupText = page.getByRole("textbox", { name: "Agent setup prompt" });
            await expect(details).toBeInViewport();
            await expect(setupText).toBeHidden();
            await page.screenshot({ path: testInfo.outputPath(`01-home-${viewport.name}.png`), fullPage: true });

            await copy.click();
            const instruction = await page.evaluate(() => navigator.clipboard.readText());
            expect(instruction).toBe(`Fetch ${runtime.origin}/setup.md and set up Morty for me.`);
            await expect(page.getByRole("status", { name: "Setup next step" })).toContainText(
                "Paste into your agent, then open the link it returns.",
            );
            await details.click();
            await expect(setupText).toBeVisible();
            await expect(setupText).toHaveValue(instruction);
            await page.screenshot({
                path: testInfo.outputPath(`07-setup-prompt-${viewport.name}.png`),
                fullPage: true,
            });
            await setupText.click();
            await expect(page.getByRole("status", { name: "Setup next step" })).toBeVisible();
            await details.click();
            await expect(setupText).toBeHidden();
            await page.screenshot({ path: testInfo.outputPath(`02-next-step-${viewport.name}.png`), fullPage: true });

            // The controlled Agent follows the served instructions through the
            // real setup, Chat, Platform and daemon, returning the user's link.
            const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
            await page.goto(connected.url);
            await expect(page).toHaveURL((url) => url.pathname === "/chat" && url.searchParams.has("sessionId"));
            const sessionUrl = page.url();
            const tip = page.getByRole("region", { name: "Continue your work here" });
            await expect(tip).toBeVisible();
            await expect(tip).toContainText("Your original session is open.");
            const composer = page.getByRole("textbox", { name: "Message" });
            await expect(composer).toBeEnabled();
            await expect(page.getByTestId(dataTestId.userMessage)).toHaveCount(0);
            await page.screenshot({
                path: testInfo.outputPath(`03-original-session-${viewport.name}.png`),
                fullPage: true,
            });

            await tip.getByRole("button", { name: "Ask for a progress update" }).click();
            await expect(composer).toHaveValue(
                "Summarize the current task's progress and anything that needs my attention.",
            );
            await expect(page.getByTestId(dataTestId.userMessage)).toHaveCount(0);
            await expect(tip).toHaveCount(0);
            await page.screenshot({
                path: testInfo.outputPath(`04-editable-draft-${viewport.name}.png`),
                fullPage: true,
            });

            await composer.fill("Tell me the current progress.");
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
                "Tell me the current progress.",
            );
            expect(await page.getByTestId(dataTestId.userMessage).count()).toBe(1);
            await page.screenshot({ path: testInfo.outputPath(`05-first-reply-${viewport.name}.png`), fullPage: true });

            await page.reload();
            await expect(composer).toBeEnabled();
            await expect(tip).toHaveCount(0);
            await page.goto(connected.url);
            await expect(page).toHaveURL(sessionUrl);
            await expect(composer).toBeEnabled();
            await expect(tip).toHaveCount(0);
            await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
                "Tell me the current progress.",
            );
            expect(await page.getByTestId(dataTestId.userMessage).count()).toBe(1);
            await page.screenshot({
                path: testInfo.outputPath(`06-return-visit-${viewport.name}.png`),
                fullPage: true,
            });
        });
    });
}
