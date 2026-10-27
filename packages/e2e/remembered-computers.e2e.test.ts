import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
]) {
    test(`Given two computers on ${viewport.name}, When I return and open the other computer in a tab, Then each computer keeps its conversation and the current computer is visible`, async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await page.setViewportSize(viewport);
        await runtime.openPairedChat();
        await page.getByRole("textbox", { name: "Message" }).fill("Computer A release checklist");
        await page.getByRole("button", { name: "Send message" }).click();
        await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
            "Computer A release checklist",
        );
        const firstAddress = page.url();

        await runtime.openPairedChat("Office MacBook");
        await page.getByRole("textbox", { name: "Message" }).fill("Computer B release checklist");
        await page.getByRole("button", { name: "Send message" }).click();
        await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
            "Computer B release checklist",
        );
        const secondAddress = page.url();
        await page.goto(new URL("/", secondAddress).href);
        await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
            "Computer B release checklist",
        );
        await expect(page.getByRole("button", { name: "Switch computer, Office MacBook" })).toBeVisible();
        await page.getByRole("button", { name: "Switch computer, Office MacBook" }).click();
        const firstComputer = page.getByRole("menuitem").filter({ hasText: "Browser test Runtime" });
        await expect(firstComputer).toContainText("Online");
        await expect(firstComputer.getByTitle(/\/workspace$/)).toHaveText("workspace");
        await expect(page.getByRole("menuitem", { name: "Connect another computer" })).toBeVisible();
        await page.screenshot({
            path: testInfo.outputPath("computer-picker.png"),
            fullPage: true,
            animations: "disabled",
        });
        const firstHref = await firstComputer.getAttribute("href");
        if (firstHref === null) {
            throw new Error("The computer must expose a normal link");
        }
        expect(new URL(firstHref, page.url()).searchParams.get("sessionId")).toBe(
            new URL(firstAddress).searchParams.get("sessionId"),
        );
        const otherTab = await page.context().newPage();
        await otherTab.setViewportSize(viewport);
        await otherTab.goto(new URL(firstHref, page.url()).href);
        await expect(otherTab.getByRole("article", { name: "Agent response" })).toContainText(
            "Computer A release checklist",
        );
        await expect(otherTab.getByRole("button", { name: "Switch computer, Browser test Runtime" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
            "Computer B release checklist",
        );
        await page.getByRole("textbox", { name: "Message" }).fill("Unsent work on B");
        await runtime.restartRuntime();
        await expect(otherTab.getByTestId(dataTestId.botConnectionStatus)).toHaveAttribute(
            "data-connection-status",
            "connected",
        );
        await page.goto(new URL("/chat", secondAddress).href);
        await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
            "Computer B release checklist",
        );
        await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Unsent work on B");
        await expect(otherTab.getByRole("textbox", { name: "Message" })).toHaveValue("");
        expect(new URL(page.url()).searchParams.get("identity")).toBe(
            new URL(secondAddress).searchParams.get("identity"),
        );
        await page.screenshot({
            path: testInfo.outputPath("restored-conversation.png"),
            fullPage: true,
            animations: "disabled",
        });
        await otherTab.close();
        await page.getByRole("button", { name: "Switch computer, Office MacBook" }).click();
        await page.getByRole("menuitem", { name: "Connect another computer" }).click();
        await expect(page.getByRole("heading", { name: "Connect another computer" })).toBeVisible();
        await page.screenshot({
            path: testInfo.outputPath("connect-another-computer.png"),
            fullPage: true,
            animations: "disabled",
        });
        await page.getByRole("link", { name: "Back to your last computer" }).click();
        await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
            "Computer B release checklist",
        );
        // The sharing code can expire independently of the access it issued.
        const scope = new URL(secondAddress).searchParams.get("identity");
        const projectId = scope?.split("~")[1];
        if (projectId === undefined) {
            throw new Error("Expected the computer's project in its address");
        }
        await page.goto(
            new URL(`/continue#code=mobius_transfer_v2.${projectId}.${"a".repeat(43)}`, secondAddress).href,
        );
        await expect(page.getByRole("button", { name: "Switch computer, Office MacBook" })).toBeVisible();
        expect(new URL(page.url()).searchParams.get("identity")).toBe(scope);
    });
}
