import { expect, test } from "./infra/test.ts";

test("Given an agent answer with reasoning and a tool call, When the user reads it, Then agent work is grayer than the answer", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();

    await page.getByRole("textbox", { name: "Message" }).fill("distinguish agent work");
    await page.getByRole("button", { name: "Send message" }).click();

    const response = page.getByRole("article", { name: "Agent response" }).filter({
        hasText: "The requested update is complete.",
    });
    const answer = response.getByText("The requested update is complete.", { exact: true });
    const reasoningSummary = page.getByText("Show Thinking", { exact: true });
    const toolDisclosure = page.getByRole("button", { name: "Inspect workspace Tool succeeded" });
    await expect(answer).toBeVisible();
    await page.getByRole("button", { name: "Show execution details", exact: true }).click();

    const answerColor = await answer.evaluate((element) => getComputedStyle(element).color);
    const agentWorkColor = await reasoningSummary.evaluate((element) => getComputedStyle(element).color);
    expect(agentWorkColor).not.toBe(answerColor);
    await expect(toolDisclosure).toHaveCSS("color", agentWorkColor);

    await reasoningSummary.click();
    await page.mouse.move(0, 0);
    await page.screenshot({ fullPage: true, path: testInfo.outputPath("agent-work.png") });
    const reasoning = page.getByText("Inspecting the request before acting.", { exact: true });
    await expect(reasoning).toBeVisible();
    await expect(reasoning).not.toHaveCSS("color", answerColor);
});

test("Given a working reply, When the user reloads after 65 seconds, Then elapsed time and live content remain consistent", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await page.clock.setFixedTime(new Date("2026-10-13T08:00:00Z"));
    await runtime.openPairedChat();

    await page.getByRole("textbox", { name: "Message" }).fill("First conversation");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page).toHaveURL((url) => url.searchParams.has("sessionId"));
    const workingConversation = page.getByRole("button", { name: /First conversation.*Session working/u });
    const firstConversationResponse = page
        .getByRole("article", { name: "Agent response" })
        .filter({ hasText: "First conversation" });
    await expect(firstConversationResponse).toHaveCount(1);
    await expect(firstConversationResponse).toBeVisible();

    await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden();
    await expect(workingConversation).toBeHidden();
    const sessionUrl = page.url();
    await page.reload();
    await expect(page).toHaveURL(sessionUrl);
    await expect(firstConversationResponse).toHaveCount(1);
    await expect(firstConversationResponse).toBeVisible();

    await page.getByRole("button", { name: "New Session" }).click();
    await page.getByRole("textbox", { name: "Message" }).fill("hold after first delta");
    await page.getByRole("button", { name: "Send message" }).click();
    const partialResponse = page.getByRole("article", { name: "Agent response" }).filter({ hasText: "Partial reply" });
    await expect(partialResponse).toHaveCount(1);
    await expect(partialResponse).toBeVisible();
    await expect(page.getByText("partial.bin", { exact: true })).toBeVisible();
    const activeSessionUrl = page.url();
    await page.clock.setFixedTime(new Date("2026-10-13T08:01:05Z"));
    await page.reload();
    await expect(page.getByRole("status", { name: "Agent is working" })).toHaveText("Working for 1min 5s");
    await page.screenshot({ fullPage: true, path: testInfo.outputPath("active-turn-primary.png") });

    const secondPage = await page.context().newPage();
    try {
        await secondPage.goto(activeSessionUrl);
        const secondPagePartialResponse = secondPage
            .getByRole("article", { name: "Agent response" })
            .filter({ hasText: "Partial reply" });
        await expect(secondPagePartialResponse).toHaveCount(1);
        await expect(secondPagePartialResponse).toBeVisible();
        await expect(secondPage.getByText("partial.bin", { exact: true })).toBeVisible();
        await expect(secondPage.getByRole("button", { name: "Stop agent output", exact: true })).toBeVisible();
        await secondPage.screenshot({ fullPage: true, path: testInfo.outputPath("active-turn-secondary.png") });

        await secondPage.getByRole("button", { name: "Stop agent output", exact: true }).click();
        await expect(secondPage.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden();
        await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden();
        await expect(partialResponse).toHaveCount(1);
        await expect(secondPagePartialResponse).toHaveCount(1);
        await expect(partialResponse).toBeVisible();
        await expect(secondPagePartialResponse).toBeVisible();
        await secondPage.screenshot({ fullPage: true, path: testInfo.outputPath("completed-turn-secondary.png") });
    } finally {
        await secondPage.close();
    }
});
