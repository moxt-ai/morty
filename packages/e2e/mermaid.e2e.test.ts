import { expect, test } from "./infra/test.ts";

test("Given a paired Bot, When a Mermaid reply finishes, Then I can view, copy and enlarge the diagram", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await page.clock.install({ time: new Date("2026-10-10T12:00:00Z") });
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("draw a deployment diagram");
    await page.getByRole("button", { name: "Send message" }).click();
    const response = page.getByRole("article", { name: "Agent response" }).filter({ hasText: "Browser" });
    await expect(response).toContainText("Browser --> Worker");
    await expect(response.getByRole("img", { name: "Mermaid chart", exact: true })).toHaveCount(0);

    await runtime.continueReply("draw a deployment diagram", {
        outcome: "complete",
        output: [],
    });
    const diagram = response.getByRole("img", { name: "Mermaid chart", exact: true });
    await expect(diagram).toBeVisible();
    await expect(diagram).toContainText("Worker");
    await expect(diagram).toContainText("Agent");
    await expect(diagram.getByText("Browser", { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(diagram.getByText("Worker", { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(diagram.getByText("Agent", { exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("mermaid-streamed.png"), fullPage: true });

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await response.getByRole("button", { name: "Copy diagram source", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Worker --> Agent");
    await response.getByRole("button", { name: "View diagram fullscreen", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByText("Worker", { exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("mermaid-fullscreen.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await expect(diagram).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(diagram).toBeVisible();
    await expect(diagram.getByText("Browser", { exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("mermaid-mobile.png"), fullPage: true });
});

test("Given a live reply with a closed Mermaid fence, When I read the response, Then the sequence diagram is visible before the turn ends", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await page.clock.install({ time: new Date("2026-10-10T12:00:00Z") });
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("draw a sequence diagram");
    await page.getByRole("button", { name: "Send message" }).click();
    const response = page.getByRole("article", { name: "Agent response" }).filter({ hasText: "Request sequence." });
    const diagram = response.getByRole("img", { name: "Mermaid chart", exact: true });
    await expect(diagram).toBeVisible();
    await expect(diagram).toContainText("Send request");
    await expect(diagram.getByText("Send request", { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeVisible();
    await response.getByText("View diagram source", { exact: true }).click();
    await expect(response.getByText("Client->>Server: Send request", { exact: false }).last()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mermaid-sequence.png"), fullPage: true });
    await runtime.continueReply("draw a sequence diagram", { outcome: "complete", output: [] });
    await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden();
    await expect(diagram).toBeVisible();
});
