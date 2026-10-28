import { expect, test } from "./infra/test.ts";

test.describe("answer request spacing", () => {
    test.use({ runtimeAgent: { id: "interaction-test", name: "Interaction Agent" } });

    test("Given a pending answer request, When it is shown, Then the card sits 8px above the composer", async ({
        runtime,
    }) => {
        const { page } = runtime;
        await runtime.openPairedChat();

        await page.getByRole("textbox", { name: "Message" }).fill("Review the verification action");
        await page.getByRole("button", { name: "Send message" }).click();
        const permission = page.getByRole("alertdialog", { name: "Agent permission request" });
        await expect(permission).toBeVisible();
        await permission.getByRole("button", { name: "Allow: Yes" }).click();

        const form = page.getByRole("dialog", { name: "Agent information request" });
        await expect(form).toBeVisible();
        const gap = await form.evaluate((card) => {
            const composer = document.querySelector('textarea[aria-label="Message"]');
            const composerForm = composer?.closest("form");
            if (!(composerForm instanceof HTMLElement)) {
                throw new Error("Expected the message composer form");
            }
            return composerForm.getBoundingClientRect().top - card.getBoundingClientRect().bottom;
        });
        expect(gap).toBeCloseTo(8, 1);
    });

    test("Given a pending answer request, When the agent waits for the user, Then no generating text shimmers", async ({
        runtime,
    }) => {
        const { page } = runtime;
        await runtime.openPairedChat();

        await page.getByRole("textbox", { name: "Message" }).fill("Review the verification action");
        await page.getByRole("button", { name: "Send message" }).click();
        const permission = page.getByRole("alertdialog", { name: "Agent permission request" });
        await expect(permission).toBeVisible();
        await permission.getByRole("button", { name: "Allow: Yes" }).click();

        const form = page.getByRole("dialog", { name: "Agent information request" });
        await expect(form).toBeVisible();
        await expect(page.locator(".animate-loading-text-shimmer")).toHaveCount(0);
    });

    test("Given a tall permission request, When it is shown, Then the interaction scroller is capped at 360px", async ({
        runtime,
    }) => {
        const { page } = runtime;
        await page.setViewportSize({ width: 851, height: 1600 });
        await runtime.openPairedChat();

        await page.getByRole("textbox", { name: "Message" }).fill("request long permission");
        await page.getByRole("button", { name: "Send message" }).click();
        const permission = page.getByRole("alertdialog", { name: "Agent permission request" });
        await expect(permission).toContainText("long-directory-");
        await expect(permission).toBeVisible();
        const scroller = permission.locator("xpath=ancestor::div[contains(@class, 'overflow-y-auto')][1]");
        const box = await scroller.boundingBox();
        if (box === null) {
            throw new Error("Expected the visible interaction scroller");
        }
        expect(box.height).toBeCloseTo(360, 0);
    });
});

test.describe("working text shimmer", () => {
    test("Given a running turn, When the user reads Working, Then its text uses the text-shimmer animation", async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await runtime.openPairedChat();

        await page.getByRole("textbox", { name: "Message" }).fill("interleaved compaction hold");
        await page.getByRole("button", { name: "Send message" }).click();

        const working = page.getByRole("status", { name: "Agent is working" });
        await expect(working).toBeVisible();
        const shimmer = working.getByText(/^Working for /u);
        await expect(shimmer).toHaveCSS("animation-name", "loading-text-shimmer");
        await expect(shimmer).toHaveCSS("animation-duration", "2.2s");
        await expect(shimmer).toHaveCSS("animation-iteration-count", "infinite");
        await expect(shimmer).toHaveCSS("background-clip", "text");
        await expect(shimmer).toHaveCSS("color", "rgba(0, 0, 0, 0)");
        await page.screenshot({
            animations: "disabled",
            path: testInfo.outputPath("working-text-shimmer.png"),
        });
    });
});
