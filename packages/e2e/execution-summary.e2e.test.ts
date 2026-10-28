import { expect, test } from "./infra/test.ts";

for (const width of [1280, 390]) {
    test(`Given consecutive execution calls at ${width}px, When I expand them and the turn completes, Then the history stays open and the answer remains separate`, async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await page.setViewportSize({ width, height: 900 });
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.clock.install({ time: new Date("2026-10-28T08:00:00Z") });
        await runtime.openPairedChat();
        const prompt = "Review the execution summary behavior";
        await page.getByRole("textbox", { name: "Message" }).fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();
        const history = page.getByRole("group", { name: "Execution details", exact: true });
        const summary = history.getByRole("button", { name: "Show execution details" });
        await expect(summary).toContainText("3 steps");
        await expect(summary).toHaveAttribute("aria-expanded", "false");
        const introduction = "I'll review the implementation and check the interactions.";
        const progressMessage = page.getByRole("article", { name: "Agent response" }).filter({ hasText: introduction });
        await progressMessage.getByRole("button", { name: "Copy response", exact: true }).click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(introduction);
        await page.clock.fastForward(2100);
        await expect(history.getByRole("group", { name: "Tool: Read the conversation layout" })).toBeHidden();
        await page.screenshot({
            path: testInfo.outputPath(`execution-collapsed-${width}.png`),
            fullPage: true,
            animations: "disabled",
        });
        await summary.focus();
        await page.keyboard.press("Enter");
        const expanded = history.getByRole("button", { name: "Hide execution details" });
        const tool = history.getByRole("group", { name: "Tool: Verify disclosure state" });
        await tool.getByRole("button").click();
        await expect(tool).toContainText("New calls preserve the user's expanded choice.");
        await page.screenshot({
            path: testInfo.outputPath(`execution-expanded-${width}.png`),
            fullPage: true,
            animations: "disabled",
        });
        await runtime.continueReply(prompt, {
            outcome: "complete",
            output: [
                {
                    kind: "activity",
                    activityType: "tool",
                    title: "Review test results",
                    output: "The execution summary checks passed.",
                    content: [],
                },
                {
                    kind: "message",
                    text: "Review complete. Execution details stay collapsed by default, expand on demand, and remain open when new calls arrive or the turn finishes.",
                },
            ],
        });
        await expect(page.getByText("Review complete.", { exact: false })).toBeVisible();
        await expect(expanded).toHaveAttribute("aria-expanded", "true");
        await expect(history.getByRole("group", { name: "Tool: Review test results" })).toBeVisible();
        await expect(tool).toContainText("New calls preserve the user's expanded choice.");
        const finalAnswer = page
            .getByRole("article", { name: "Agent response" })
            .filter({ hasText: "Review complete." });
        await finalAnswer.getByRole("button", { name: "Copy response", exact: true }).click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
            "Review complete. Execution details stay collapsed by default, expand on demand, and remain open when new calls arrive or the turn finishes.",
        );
        await page.clock.fastForward(2100);
        await expanded.click();
        await expect(summary).toContainText("Operations complete");
        await expect(summary).toContainText("4 steps");
        await page.screenshot({
            path: testInfo.outputPath(`execution-completed-${width}.png`),
            fullPage: true,
            animations: "disabled",
        });
        const box = await summary.boundingBox();
        expect(box).not.toBeNull();
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
        await page.reload();
        await expect(summary).toHaveAttribute("aria-expanded", "false");
        await expect(page.getByText("Review complete.", { exact: false })).toBeVisible();
    });
}
