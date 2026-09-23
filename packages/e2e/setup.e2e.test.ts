import { readFile, realpath, stat } from "node:fs/promises";
import jsQrImport from "jsqr";
import { PNG } from "pngjs";
import { expect, test } from "./infra/test.ts";

test("Given another Project has a managed Runtime, When pair redeems a Bot ticket, Then it creates a fresh Runtime for the ticket Project", async ({
    runtime,
}) => {
    await runtime.openChat();
    await runtime.connectUnrelatedRuntime();
    const instructionUrl = await runtime.createPairInstruction();

    const connected = await runtime.followInstructions(instructionUrl);
    const statuses = connected.events.map((event) => event.status);

    expect(statuses).toContain("prepared");
    expect(statuses).not.toContain("runtime_reused");
    expect(statuses).toContain("ready");
});

test("Given a saved setup handoff, When its Runtime reconnects, Then setup waits for the agent to come online", async ({
    runtime,
}) => {
    await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    await runtime.disconnectRuntime();
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    const statuses = connected.events.map((event) => event.status);

    expect(statuses).toEqual(
        expect.arrayContaining(["runtime_reused", "runtime_paired", "runtime_online", "binding_activated"]),
    );
    expect(statuses.indexOf("runtime_reused")).toBeLessThan(statuses.indexOf("runtime_paired"));
    expect(statuses.indexOf("runtime_paired")).toBeLessThan(statuses.indexOf("runtime_online"));
    expect(statuses.indexOf("runtime_online")).toBeLessThan(statuses.indexOf("binding_activated"));
    expect(connected.configuration).not.toHaveProperty("pairing");
    expect(connected.configuration).not.toHaveProperty("pairing_key");
    expect(connected.configuration).not.toHaveProperty("expected_runtime_id");
    expect(connected.configuration).not.toHaveProperty("runtime_process");
});

test("Given a setup handoff, When a user imports a native session, Then the handoff persists until access is revoked", async ({
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

    await test.step("import the native session and reload its history", async () => {
        await page.goto(connected.url);
        await expect(page.getByRole("heading", { name: "Continue native session" })).toBeVisible();
        await page.getByRole("button", { name: "Import session", exact: true }).click();
        const messages = page.getByRole("log", { name: "Messages", exact: true });
        await expect(messages).toContainText("Continue this setup session");
        await expect(composer).toBeVisible();
        const conversationUrl = page.url();
        await page.reload();
        expect(page.url()).toBe(conversationUrl);
        await expect(messages).toContainText("Continue this setup session");
    });

    await test.step("end remote access", async () => {
        await page.getByRole("button", { name: "End remote access", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "End remote access?" });
        await expect(dialog).toContainText("every browser using this access link");
        await dialog.getByRole("button", { name: "End remote access", exact: true }).click();
        await expect(dialog).toBeHidden();
    });
});
