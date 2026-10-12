import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { expect, test } from "./infra/test.ts";

test("Given Claude Code's adapter is installing, When a user pairs the Machine, Then setup waits until Claude Code is ready", async ({
    runtime,
}) => {
    await runtime.openChat();
    runtime.pairWithInstallingAgent();
    const instructionUrl = await runtime.createPairInstruction();

    const connected = await runtime.followInstructions(instructionUrl);

    expect(connected.events).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                status: "progress",
                stage: "runtime",
                message: "Waiting for claude to finish installing.",
            }),
            expect.objectContaining({ status: "ready" }),
        ]),
    );
});

test("Given Claude Code's adapter stays installing, When a user pairs the Machine, Then setup times out after sixty seconds", async ({
    runtime,
}) => {
    await runtime.openChat();
    runtime.pairWithStalledInstallingAgent();
    const instructionUrl = await runtime.createPairInstruction();

    await expect(runtime.followInstructions(instructionUrl)).rejects.toThrow(/HARNESS_INSTALL_TIMEOUT/u);

    expect(runtime.setupElapsedMilliseconds()).toBe(60_000);
});

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
