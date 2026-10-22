import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given a saved setup handoff, When its Runtime reconnects, Then setup returns a concise QR image reference", async ({
    runtime,
}) => {
    const original = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    await runtime.disconnectRuntime();
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    const statuses = connected.events.map((event) => event["status"]);

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
    const ready = connected.events.find((event) => event["status"] === "ready");
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
    const statuses = connected.events.map((event) => event["status"]);
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

test("Given a healthy connected Runtime, When setup runs again, Then it reuses the live connection and hands off to Chat", async ({
    runtime,
}) => {
    const original = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    expect(connected.botId).toBe(original.botId);
    expect(connected.events).toContainEqual(expect.objectContaining({ status: "runtime_already_online" }));
    expect(connected.events).not.toContainEqual(expect.objectContaining({ status: "runtime_started" }));
    await runtime.page.goto(connected.url);
    await expect(runtime.page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await runtime.page.getByRole("textbox", { name: "Message" }).fill("Hello after repeated setup");
    await runtime.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(runtime.page.getByRole("article", { name: "Agent response" })).toContainText(
        "Hello after repeated setup",
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

test("Given setup was previously paired in another directory, When a new project handoff opens, Then new sessions use the reported project directory", async ({
    runtime,
}, testInfo) => {
    const original = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    const workspace = join(
        original.workspace,
        "project with spaces \u00e9",
        ...Array.from({ length: 4 }, () => "\u00e9".repeat(90)),
    );
    await mkdir(workspace, { recursive: true });
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session", 5000, workspace);
    expect(connected.workspace).toBe(workspace);
    await runtime.page.goto(connected.url);
    await expect(runtime.page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await runtime.page.reload();
    await runtime.page.getByRole("button", { name: "New Session", exact: true }).click();
    await expect(runtime.page.getByTestId(dataTestId.workingDirectory)).toContainText("\u00e9".repeat(90));
    await runtime.page.getByRole("textbox", { name: "Message" }).fill("Verify the setup project directory");
    await runtime.page.getByRole("button", { name: "Send message" }).click();
    await expect(runtime.page.getByRole("article", { name: "Agent response" })).toContainText(
        "Verify the setup project directory",
    );
    await runtime.page.getByRole("button", { name: "Show execution details" }).click();
    await expect(runtime.page.getByTestId(dataTestId.executionDirectory)).toHaveText(workspace);
    await runtime.page.screenshot({ path: testInfo.outputPath("long-workspace-handoff.png"), fullPage: true });
});
