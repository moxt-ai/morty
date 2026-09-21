import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import jsQrImport from "jsqr";
import { PNG } from "pngjs";
import { dataTestId } from "../web/src/data-testid.ts";
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
        expect(connected.workspace).toBe(await realpath(runtime.workspace));
        const statuses = connected.events.map((event) => event.status);
        expect(statuses.indexOf("runtime_paired")).toBeLessThan(statuses.indexOf("binding_activated"));
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

    await test.step("generate media and recover it after reload", async () => {
        await composer.fill("generate media artifacts");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByRole("img", { name: "generated-image.png", exact: true })).toBeVisible();
        await expect(page.locator('video[aria-label="generated-video.mp4"]')).toHaveAttribute(
            "src",
            /^data:video\/mp4;base64,/u,
        );
        const conversationUrl = page.url();
        await page.reload();
        expect(page.url()).toBe(conversationUrl);
        await expect(page.getByRole("img", { name: "Generated image", exact: true })).toBeVisible();
        await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText(
            "Hello from the setup journey",
        );
    });

    await test.step("pull a local image referenced by the user message", async () => {
        const path = join(runtime.workspace, "user-local-image.png");
        await writeFile(
            path,
            Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                "base64",
            ),
        );
        const prompt = `Show this local image: ![User local image](<${path}>)`;
        await composer.fill(prompt);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const userMessage = page
            .getByTestId(dataTestId.userMessage)
            .filter({ hasText: "Show this local image:" })
            .last();
        await expect(userMessage.getByRole("img", { name: "User local image", exact: true })).toBeVisible();
        await expect(userMessage.getByText("Image not available", { exact: true })).toHaveCount(0);
        await page.reload();
        await expect(
            page
                .getByTestId(dataTestId.userMessage)
                .filter({ hasText: "Show this local image:" })
                .last()
                .getByRole("img", { name: "User local image", exact: true }),
        ).toBeVisible();
    });

    await test.step("open local text and image links over the conversation", async () => {
        await page.setViewportSize({ width: 1280, height: 800 });
        const textPath = join(runtime.workspace, "preview-notes.txt");
        const imagePath = join(runtime.workspace, "preview-image.png");
        const binaryPath = join(runtime.workspace, "preview-data.bin");
        await writeFile(textPath, "Local preview from the Runtime\n");
        await writeFile(binaryPath, Buffer.from([0, 1, 2, 3]));
        await writeFile(
            imagePath,
            Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                "base64",
            ),
        );
        const prompt = `Open [preview-notes.txt](<${textPath}>), [preview-image.png](<${imagePath}>), or [preview-data.bin](<${binaryPath}>).`;
        await composer.fill(prompt);
        await page.getByTestId(dataTestId.sendMessage).click();
        const composerBeforePreview = await page.getByTestId(dataTestId.messageComposer).boundingBox();

        await page.getByTestId(dataTestId.localFileLink).filter({ hasText: "preview-notes.txt" }).first().click();
        await expect(page.getByTestId(dataTestId.filePreview)).toBeVisible();
        await expect(page.getByTestId(dataTestId.filePreviewContent)).toHaveText("Local preview from the Runtime");
        await expect(page.getByTestId(dataTestId.filePreview)).toHaveCSS("width", "640px");
        expect(await page.getByTestId(dataTestId.messageComposer).boundingBox()).toEqual(composerBeforePreview);
        await page.getByTestId(dataTestId.closeFilePreview).click();
        await expect(page.getByTestId(dataTestId.filePreview)).toHaveCount(0);

        await page.getByTestId(dataTestId.localFileLink).filter({ hasText: "preview-image.png" }).first().click();
        await expect(page.getByTestId(dataTestId.filePreviewContent)).toHaveAttribute("src", /^blob:/u);
        await page.getByTestId(dataTestId.closeFilePreview).click();
        await expect(page.getByTestId(dataTestId.filePreview)).toHaveCount(0);

        const downloadPromise = page.waitForEvent("download");
        await page.getByTestId(dataTestId.localFileLink).filter({ hasText: "preview-data.bin" }).first().click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe("preview-data.bin");
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
