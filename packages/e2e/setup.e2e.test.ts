import { readFile, stat } from "node:fs/promises";
import jsQrImport from "jsqr";
import { PNG } from "pngjs";
import { expect, test } from "./infra/test.ts";

test("Given a setup handoff, When a user continues remote work, Then setup, ACP controls, media, persistence, and revocation form one working journey", async ({
    runtime,
}) => {
    const { page } = runtime;
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    const sessionId = "setup-journey-session";
    await runtime.seedNativeSession(sessionId, "Continue this setup session");
    const connected = await runtime.followInstructions("/setup.md", sessionId);

    await test.step("verify the private browser handoff", async () => {
        expect(connected.botId).toBe(connected.identity.botId);
        expect(connected.expiresAt).toBeTruthy();
        expect(connected.message).toContain("Keep the Runtime online");
        expect(new URL(connected.url).pathname).toBe("/continue");
        expect(new URL(connected.url).searchParams.get("harness")).toBe("opencode");
        expect(new URL(connected.url).searchParams.get("sessionId")).toBe(sessionId);
        expect((await stat(connected.qrTextPath)).mode & 0o777).toBe(0o600);
        expect(await readFile(connected.qrTextPath, "utf8")).toContain("█");
        expect((await stat(connected.qrPath)).mode & 0o777).toBe(0o600);
        const image = PNG.sync.read(await readFile(connected.qrPath));
        const decoder: unknown = jsQrImport;
        expect(typeof decoder).toBe("function");
        if (typeof decoder === "function") {
            const decoded: unknown = decoder(new Uint8ClampedArray(image.data), image.width, image.height);
            expect(decoded).toMatchObject({ data: connected.url });
        }
    });

    await test.step("import the native session and continue its history", async () => {
        await page.goto(connected.url);
        await expect(page.getByRole("heading", { name: "Continue native session" })).toBeVisible();
        await page.getByRole("button", { name: "Import session", exact: true }).click();
        const messages = page.getByRole("log", { name: "Messages", exact: true });
        await expect(messages).toContainText("Continue this setup session");
        await expect(composer).toBeVisible();
        await composer.fill("Hello from the setup journey");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(messages).toContainText("Hello from the setup journey");
    });

    await test.step("answer ACP permission and elicitation from mobile", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await composer.fill("exercise ACP controls");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const permission = page.getByRole("alertdialog", { name: "Agent permission request", exact: true });
        await expect(permission).toContainText("Run the verification command");
        await permission.getByRole("button", { name: "Allow once", exact: true }).dispatchEvent("click");

        const elicitation = page.getByRole("dialog", { name: "Agent information request", exact: true });
        await expect(elicitation).toContainText("Choose the branch to verify");
        await elicitation.getByRole("textbox").fill("mobile-approval");
        await elicitation.getByRole("button", { name: "Continue", exact: true }).dispatchEvent("click");
        await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText("mobile-approval");
    });

    await test.step("cancel active work", async () => {
        await composer.fill("wait until cancelled");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByRole("status", { name: "Agent working", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Stop agent output", exact: true }).click();
        await expect(page.getByText("Response cancelled.", { exact: true })).toBeVisible();
    });

    await test.step("generate media and recover it after reload", async () => {
        await composer.fill("generate media artifacts");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByRole("img", { name: "generated-image.png", exact: true })).toBeVisible();
        await expect(page.locator('video[aria-label="generated-video.mp4"]')).toHaveAttribute("src", /^blob:/u);
        const conversationUrl = page.url();
        await page.reload();
        expect(page.url()).toBe(conversationUrl);
        await expect(page.getByRole("img", { name: "generated-image.png", exact: true })).toBeVisible();
        await expect(page.locator('video[aria-label="generated-video.mp4"]')).toHaveAttribute("src", /^blob:/u);
        await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText(
            "Hello from the setup journey",
        );
    });

    await test.step("preserve active work across reload and end remote access", async () => {
        await composer.fill("wait until cancelled");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByRole("status", { name: "Agent working", exact: true })).toBeVisible();
        await page.reload();
        await expect(page.getByRole("status", { name: "Agent working", exact: true })).toBeVisible();
        await expect(
            page.getByText("Agent updates stopped. Check your local agent or reconnect.", { exact: true }),
        ).toHaveCount(0);
        await page.getByRole("button", { name: "End remote access", exact: true }).click();
        await page.getByRole("button", { name: "Confirm end access", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Remote access ended", exact: true })).toBeVisible();
        await expect(
            page.getByText("Your local task is still running on your computer.", { exact: false }),
        ).toBeVisible();
    });
});
