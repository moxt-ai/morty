import { readFile, stat } from "node:fs/promises";
import jsQrImport from "jsqr";
import { PNG } from "pngjs";
import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given setup creates a browser handoff, When setup becomes ready, Then the exact link and a private QR are available", async ({
    runtime,
}) => {
    const sessionId = "setup-qr-session";
    await runtime.seedNativeSession(sessionId, "Prepare QR handoff");

    const connected = await runtime.followInstructions("/setup.md", sessionId);

    expect(connected.expiresAt).toBeTruthy();
    expect(connected.message).toContain("Keep the Runtime online");
    expect(connected.qrText).toContain("█");
    expect((await stat(connected.qrPath)).mode & 0o777).toBe(0o600);
    const image = PNG.sync.read(await readFile(connected.qrPath));
    const decoder: unknown = jsQrImport;
    expect(typeof decoder).toBe("function");
    if (typeof decoder !== "function") {
        return;
    }
    const decoded: unknown = decoder(new Uint8ClampedArray(image.data), image.width, image.height);
    expect(decoded).toMatchObject({ data: connected.url });
});

for (const mode of ["pair", "setup"]) {
    test(`Given a user following ${mode}.md, When they pair, chat and reload, Then the agent replies without re-pairing`, async ({
        runtime,
    }) => {
        const { page } = runtime;
        if (mode === "pair") {
            const originalIdentity = await runtime.openChat();
            const instruction = await page.getByTestId(dataTestId.pairingInstruction).inputValue();
            expect(instruction).toMatch(/^follow /u);
            const connected = await runtime.followInstructions(instruction.slice("follow ".length));
            expect(connected.identity).toEqual(originalIdentity);
            expect(connected.botId).toBe(originalIdentity.botId);
            expect(connected.url).toBe(runtime.origin);
            await page.reload();
        } else {
            const sessionId = "setup-source-session";
            await runtime.seedNativeSession(sessionId, "Continue this setup session");
            const connected = await runtime.followInstructions("/setup.md", sessionId);
            expect(connected.botId).toBe(connected.identity.botId);
            expect(new URL(connected.url).pathname).toBe("/continue");
            expect(new URL(connected.url).searchParams.get("harness")).toBe("opencode");
            expect(new URL(connected.url).searchParams.get("sessionId")).toBe(sessionId);
            expect(connected.expiresAt).toBeTruthy();
            const [continuation] = await Promise.all([
                page.waitForResponse(
                    (response) =>
                        response.request().method() === "POST" &&
                        new URL(response.url()).pathname.endsWith("/continue-native-session"),
                ),
                page.goto(connected.url),
            ]);
            expect(continuation.status()).toBe(200);
            expect(await continuation.json()).toMatchObject({ result: { action: "fork" } });
            await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText(
                "Continue this setup session",
            );
        }

        const composer = page.getByTestId(dataTestId.messageComposer);
        await expect(composer).toBeVisible();
        await page.reload();
        await expect(composer).toBeVisible();
        await expect(page.getByTestId(dataTestId.pairingInstruction)).toHaveCount(0);

        const prompt = `Hello from the ${mode}.md journey`;
        if (mode === "pair") {
            await runtime.sendMessage(prompt);
            await expect(page.getByTestId(dataTestId.agentResponse).first()).toContainText(prompt);
            await expect(page.getByTestId(dataTestId.userMessage).last()).toHaveText(prompt);
        } else {
            await composer.fill(prompt);
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText(prompt);
        }
        const conversationUrl = page.url();

        await test.step("Reload the same conversation and receive a fresh reply without re-pairing", async () => {
            await page.reload();
            if (mode === "pair") {
                await expect(page.getByTestId(dataTestId.agentResponse).first()).toContainText(prompt);
            } else {
                await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText(prompt);
            }
            expect(page.url()).toBe(conversationUrl);
            await expect(page.getByTestId(dataTestId.pairingInstruction)).toHaveCount(0);
            const followUp = `Still connected after reloading ${mode}.md`;
            if (mode === "pair") {
                await runtime.sendMessage(followUp);
                await expect(page.getByTestId(dataTestId.agentResponse).nth(1)).toContainText(followUp);
                await expect(page.getByTestId(dataTestId.userMessage).last()).toHaveText(followUp);
            } else {
                await composer.fill(followUp);
                await page.getByRole("button", { name: "Send message", exact: true }).click();
                await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText(followUp);
            }
            expect(page.url()).toBe(conversationUrl);
        });
    });
}

test("Given a continued setup session needs approval, When the user decides on mobile and reloads, Then pending interactions remain actionable exactly once", async ({
    runtime,
}) => {
    const { page } = runtime;
    await page.setViewportSize({ width: 390, height: 844 });
    const sessionId = "setup-permission-session";
    await runtime.seedNativeSession(sessionId, "Prepare permission handling");
    const connected = await runtime.followInstructions("/setup.md", sessionId);
    await page.goto(connected.url);

    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(composer).toBeVisible();
    await composer.fill("exercise ACP controls");
    await page.getByRole("button", { name: "Send message", exact: true }).click();

    const permission = page.getByRole("alertdialog", { name: "Agent permission request", exact: true });
    await expect(permission).toContainText("Run the verification command");
    let permissionResponses = 0;
    page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/responses")) {
            permissionResponses += 1;
        }
    });
    const permissionResponse = page.waitForResponse(
        (response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/responses"),
        { timeout: 15_000 },
    );
    await permission.getByRole("button", { name: "Allow once", exact: true }).dispatchEvent("click");
    expect((await permissionResponse).status()).toBe(202);
    expect(permissionResponses).toBe(1);

    const elicitation = page.getByRole("dialog", { name: "Agent information request", exact: true });
    await expect(elicitation).toContainText("Choose the branch to verify", { timeout: 30_000 });
    await elicitation.getByRole("textbox").fill("mobile-approval");
    await elicitation.getByRole("button", { name: "Continue", exact: true }).dispatchEvent("click");
    await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText("mobile-approval");

    await composer.fill("exercise ACP controls");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(permission).toBeVisible();
    await page.reload();
    await expect(permission).toContainText("Run the verification command");
    await permission.getByRole("button", { name: "Reject", exact: true }).dispatchEvent("click");
    await expect(permission).toHaveCount(0);
    await expect(composer).toBeEnabled();
});

test("Given a continued setup session, When the agent creates image and video output, Then both remain available after reopening on a phone", async ({
    runtime,
}) => {
    const { page } = runtime;
    const sessionId = "setup-media-session";
    await runtime.seedNativeSession(sessionId, "Prepare media output");
    const connected = await runtime.followInstructions("/setup.md", sessionId);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(connected.url);

    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("generate media artifacts");
    await page.getByRole("button", { name: "Send message", exact: true }).click();

    await expect(page.getByRole("img", { name: "generated-image.png", exact: true })).toBeVisible();
    await expect(page.locator('video[aria-label="generated-video.mp4"]')).toHaveAttribute("src", /^blob:/u);

    await page.reload();

    await expect(page.getByRole("img", { name: "generated-image.png", exact: true })).toBeVisible();
    const video = page.locator('video[aria-label="generated-video.mp4"]');
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute("controls", "");
    await expect(video).toHaveAttribute("src", /^blob:/u);
});
