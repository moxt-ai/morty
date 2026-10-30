import type { Page } from "@playwright/test";
import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

/** Opens the computer list: the sidebar menu on desktop, the navigation drawer on mobile. */
async function openComputers(page: Page, mobile: boolean, current: string) {
    if (mobile) {
        await page.getByRole("button", { name: "Open navigation", exact: true }).click();
        const list = page.getByRole("navigation", { name: "Computers" });
        const currentChoice = list.locator("[aria-current='true']");
        return {
            current: currentChoice,
            other: (name: string) => list.getByRole("link", { name: new RegExp(name) }),
            connect: list.getByRole("link", { name: "Connect another computer" }),
            // Choosing the computer the page is already on only closes the drawer.
            close: async () => await currentChoice.click(),
        };
    }
    await page.getByRole("button", { name: `Switch computer, ${current}` }).click();
    return {
        current: page.getByRole("menuitemradio", { checked: true }),
        other: (name: string) => page.getByRole("menuitemradio", { name: new RegExp(name) }),
        connect: page.getByRole("menuitem", { name: "Connect another computer" }),
        close: async () => await page.keyboard.press("Escape"),
    };
}

/** The desktop sidebar heads with the connection; on mobile the drawer lists it with the computer. */
async function expectComputerOnline(page: Page, mobile: boolean, name: string) {
    if (!mobile) {
        await expect(page.getByTestId(dataTestId.botConnectionStatus)).toHaveAttribute(
            "data-connection-status",
            "connected",
        );
        return;
    }
    const computers = await openComputers(page, mobile, name);
    await expect(computers.current).toContainText("Online");
    await computers.close();
}

async function expectCurrentComputer(page: Page, mobile: boolean, name: string) {
    const computers = await openComputers(page, mobile, name);
    await expect(computers.current).toContainText(name);
    await computers.close();
}

for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
]) {
    test(`Given two computers on ${viewport.name}, When I return and open the other computer in a tab, Then each computer keeps its conversation and the current computer is visible`, async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        const mobile = viewport.name === "mobile";
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
        const computers = await openComputers(page, mobile, "Office MacBook");
        await expect(computers.current).toContainText("Office MacBook");
        const firstComputer = computers.other("Browser test Runtime");
        await expect(firstComputer).toContainText("Online");
        await expect(computers.connect).toBeVisible();
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
        await expectCurrentComputer(otherTab, mobile, "Browser test Runtime");
        await computers.close();
        await expect(page.getByRole("article", { name: "Agent response" })).toContainText(
            "Computer B release checklist",
        );
        await page.getByRole("textbox", { name: "Message" }).fill("Unsent work on B");
        await runtime.restartRuntime();
        await expectComputerOnline(otherTab, mobile, "Browser test Runtime");
        // Using a tab makes its computer the last one used; return to computer B before reopening Chat.
        await page.getByRole("textbox", { name: "Message" }).click();
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
        await (await openComputers(page, mobile, "Office MacBook")).connect.click();
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
        await expectCurrentComputer(page, mobile, "Office MacBook");
        expect(new URL(page.url()).searchParams.get("identity")).toBe(scope);
    });
}
