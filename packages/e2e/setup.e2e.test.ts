import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { expect, test } from "./infra/test.ts";

test("Given a saved setup handoff, When its Runtime reconnects, Then setup returns a concise QR image reference", async ({
    runtime,
}) => {
    const original = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    await runtime.disconnectRuntime();
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    const statuses = connected.events.map((event) => event.status);

    expect(connected.botId).toBe(original.botId);
    expect(statuses).not.toContain("prepared");
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
    const ready = connected.events.find((event) => event.status === "ready");
    expect(ready).not.toHaveProperty("qrDataUrl");
    expect(ready).not.toHaveProperty("qrTextPath");
    if (connected.qrPath === null) {
        throw new Error("Expected setup to return a QR image path");
    }
    expect(dirname(connected.qrPath)).toBe(tmpdir());
    expect(connected.qrPath).toMatch(/morty-handoff-[0-9a-f-]+\.png$/u);
});

test("Given a saved Machine whose Runtime the manager no longer manages, When setup reconnects, Then it replaces the Project, pairs a fresh Runtime, and keeps the user", async ({
    runtime,
}) => {
    const original = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    await runtime.forgetRuntimeConnections();
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");

    expect(connected.events).not.toContainEqual(expect.objectContaining({ status: "runtime_reused" }));
    expect(connected.identity.userId).toBe(original.identity.userId);
    expect(connected.identity.projectId).not.toBe(original.identity.projectId);
    expect(connected.botId).not.toBe(original.botId);
    const statuses = connected.events.map((event) => event.status);
    expect(statuses).toContain("prepared");
    expect(statuses).toContain("ready");
});

test("Given a saved Machine and another same-App connection, When its Runtime reconnects, Then setup reuses the Machine's bound Runtime", async ({
    runtime,
}) => {
    await runtime.openChat();
    await runtime.connectUnrelatedRuntime();
    const original = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    await runtime.disconnectRuntime();

    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session", 5_000);

    expect(connected.botId).toBe(original.botId);
    expect(connected.events).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ status: "runtime_reused" }),
            expect.objectContaining({ status: "runtime_online" }),
            expect.objectContaining({ status: "ready" }),
        ]),
    );
});

test("Given a native session handoff, When the browser opens it, Then the original session opens directly in Chat", async ({
    runtime,
}) => {
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    const { page } = runtime;
    await page.goto(connected.url);
    await expect(page).toHaveURL((url) => url.pathname === "/chat" && url.searchParams.has("sessionId"));
    await expect(page.getByRole("main", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Fork session", exact: true })).toHaveCount(0);
});

test("Given a successful native session handoff, When the browser opens the retained link again, Then it reopens the same session", async ({
    runtime,
}) => {
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    const { page } = runtime;
    await page.goto(connected.url);
    await expect(page).toHaveURL((url) => url.pathname === "/chat" && url.searchParams.has("sessionId"));
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    const sessionUrl = page.url();
    await page.goto(connected.url);
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.getByRole("main", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Given a redeemed native-session link whose original session is unavailable, When the user chooses Go to Morty, Then home keeps the redeemed access", async ({
    runtime,
}) => {
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    const missing = new URL(connected.url);
    missing.searchParams.set("sessionId", "missing-native-session");
    const { page } = runtime;
    await page.goto(missing.href);
    await expect(page.getByRole("alert")).toContainText("The native session was not found");
    const identity = new URL(page.url()).searchParams.get("identity");
    expect(identity).not.toBeNull();

    await page.getByRole("button", { name: "Go to Morty", exact: true }).click();

    await expect(page).toHaveURL((url) => url.pathname === "/" && url.searchParams.get("identity") === identity);
    const destination = new URL(page.url());
    expect(destination.searchParams.get("sessionId")).toBeNull();
    expect(destination.searchParams.get("harness")).toBeNull();
    expect(destination.hash).toBe("");
    await expect(page.getByRole("main", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
});

test("Given redeemed access and an unavailable transfer link, When the user reopens it and chooses Go to Morty, Then home retains the existing access", async ({
    runtime,
}) => {
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    const missing = new URL(connected.url);
    missing.searchParams.set("sessionId", "missing-native-session");
    const { page } = runtime;
    await page.goto(missing.href);
    await expect(page.getByRole("alert")).toContainText("The native session was not found");
    const identity = new URL(page.url()).searchParams.get("identity");
    expect(identity).not.toBeNull();
    missing.searchParams.set("identity", identity ?? "");
    missing.hash = `code=mobius_transfer_v2.${connected.identity.projectId}.${"a".repeat(43)}`;
    await page.goto(missing.href);
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("The native session was not found");

    await page.getByRole("button", { name: "Go to Morty", exact: true }).click();

    await expect(page).toHaveURL((url) => url.pathname === "/" && url.searchParams.get("identity") === identity);
    await expect(page.getByRole("main", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
});
