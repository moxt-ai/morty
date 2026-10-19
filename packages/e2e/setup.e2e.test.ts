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
