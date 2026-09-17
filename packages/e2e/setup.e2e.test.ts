import { readFile, stat } from "node:fs/promises";
import jsQrImport from "jsqr";
import { PNG } from "pngjs";
import { expect, test } from "./infra/test.ts";

test("Given setup creates a browser handoff, When setup becomes ready, Then the exact link and private QR files are available", async ({
    runtime,
}) => {
    const sessionId = "setup-qr-session";
    await runtime.seedNativeSession(sessionId, "Prepare QR handoff");

    const connected = await runtime.followInstructions("/setup.md", sessionId);

    expect(connected.expiresAt).toBeTruthy();
    expect(connected.message).toContain("Keep the Runtime online");
    expect((await stat(connected.qrTextPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(connected.qrTextPath, "utf8")).toContain("█");
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

test("Given a setup handoff names a native session, When the user imports it and reloads, Then its history remains available", async ({
    runtime,
}) => {
    const { page } = runtime;
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
        (async () => {
            await page.goto(connected.url);
            await expect(page.getByRole("heading", { name: "Continue native session" })).toBeVisible();
            await expect(page.getByText("opencode", { exact: true })).toBeVisible();
            await expect(page.getByText(sessionId, { exact: true })).toBeVisible();
            await page.getByRole("button", { name: "Import session", exact: true }).click();
        })(),
    ]);
    expect(continuation.status()).toBe(200);
    expect(await continuation.json()).toMatchObject({ result: { action: "import" } });
    const messages = page.getByRole("log", { name: "Messages", exact: true });
    await expect(messages).toContainText("Continue this setup session");

    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    const prompt = "Hello from the setup.md journey";
    await composer.fill(prompt);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(messages).toContainText(prompt);
    const conversationUrl = page.url();

    await page.reload();
    await expect(messages).toContainText(prompt);
    expect(page.url()).toBe(conversationUrl);
});

test("Given a setup handoff names a native session, When the user skips it, Then Chat opens without importing or forking", async ({
    runtime,
}) => {
    const { page } = runtime;
    const sessionId = "setup-skipped-session";
    await runtime.seedNativeSession(sessionId, "Do not continue this session");
    const connected = await runtime.followInstructions("/setup.md", sessionId);
    const continuationRequests: string[] = [];
    page.on("request", (request) => {
        if (new URL(request.url()).pathname.endsWith("/continue-native-session")) {
            continuationRequests.push(request.url());
        }
    });

    await page.goto(connected.url);

    await expect(page.getByRole("button", { name: "Import session", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Fork session", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    expect(continuationRequests).toEqual([]);
});

test("Given a continued setup session needs approval, When the user decides on mobile and reloads, Then pending interactions remain actionable exactly once", async ({
    runtime,
}) => {
    const { page } = runtime;
    await page.setViewportSize({ width: 390, height: 844 });
    const sessionId = "setup-permission-session";
    await runtime.seedNativeSession(sessionId, "Prepare permission handling");
    const connected = await runtime.followInstructions("/setup.md", sessionId);
    await page.goto(connected.url);
    await page.getByRole("button", { name: "Fork session", exact: true }).click();

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

test("Given a continued setup session exposes task controls, When the user steers, checks compaction and stops, Then controls target supported work", async ({
    runtime,
}) => {
    const { page } = runtime;
    const sessionId = "setup-task-controls-session";
    await runtime.seedNativeSession(sessionId, "Prepare task controls");
    const connected = await runtime.followInstructions("/setup.md", sessionId);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(connected.url);
    await page.getByRole("button", { name: "Fork session", exact: true }).click();

    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("wait for steering");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText("Inspecting the workspace");

    await expect(composer).toBeEnabled();
    await composer.fill("Prioritize the mobile controls");
    const steering = page.waitForResponse(
        (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname.endsWith("/turns") &&
            response.request().postDataJSON().disposition === "steer",
    );
    await page.getByRole("button", { name: "Steer active task", exact: true }).click();
    const steeringRequest = (await steering).request().postDataJSON();
    expect(steeringRequest).toMatchObject({
        content: "Prioritize the mobile controls",
        disposition: "steer",
    });
    expect(steeringRequest.targetCommandId).toBeTruthy();
    await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText(
        "Steered: Prioritize the mobile controls",
    );

    const compact = page.getByRole("button", { name: "Compact context", exact: true });
    await expect(compact).toBeDisabled();
    await expect(compact).toHaveText("Compact unavailable");
    await expect(compact).toHaveAttribute("title", "This agent does not provide a compact command.");

    await composer.fill("wait until cancelled");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const cancellation = page.waitForResponse(
        (response) =>
            response.request().method() === "POST" && /\/turns\/[^/]+\/cancel$/u.test(new URL(response.url()).pathname),
    );
    await page.getByRole("button", { name: "Stop agent output", exact: true }).click();
    expect((await cancellation).status()).toBe(202);
    await expect(page.getByText("Response cancelled.", { exact: true })).toBeVisible();
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
    await page.getByRole("button", { name: "Fork session", exact: true }).click();

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

test("Given a remote setup session, When message delivery cannot be confirmed, Then the user sees delivery unknown and chooses the only retry", async ({
    runtime,
}) => {
    const { page } = runtime;
    const sessionId = "setup-delivery-unknown-session";
    await runtime.seedNativeSession(sessionId, "Prepare uncertain delivery");
    const connected = await runtime.followInstructions("/setup.md", sessionId);
    await page.goto(connected.url);
    await page.getByRole("button", { name: "Fork session", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(composer).toBeVisible();

    await composer.fill("deliver this exactly once");
    await page.context().setOffline(true);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Delivery unknown");

    await page.context().setOffline(false);
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("will not be sent again automatically");
    await page.getByRole("button", { name: "Retry same message", exact: true }).click();
    await expect(page.getByRole("log", { name: "Messages", exact: true })).toContainText("deliver this exactly once");
});

test("Given remote access to a running local session, When the user ends access, Then remote browsers are revoked while the local task continues", async ({
    runtime,
}) => {
    const { page } = runtime;
    const sessionId = "setup-end-remote-access-session";
    await runtime.seedNativeSession(sessionId, "Keep the local task alive");
    const connected = await runtime.followInstructions("/setup.md", sessionId);
    await page.goto(connected.url);
    await page.getByRole("button", { name: "Fork session", exact: true }).click();

    await page.getByRole("button", { name: "End remote access", exact: true }).click();
    await page.getByRole("button", { name: "Confirm end access", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Remote access ended", exact: true })).toBeVisible();
    await expect(page.getByText("Your local task is still running on your computer.", { exact: false })).toBeVisible();
});
