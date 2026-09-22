import { readFile, realpath, stat } from "node:fs/promises";
import jsQrImport from "jsqr";
import { PNG } from "pngjs";
import { expect, test } from "./infra/test.ts";

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
        await page.locator('[aria-current="page"]').click({ button: "right" });
        await page.getByText("End remote access", { exact: true }).click();
    });
});
