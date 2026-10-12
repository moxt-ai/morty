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

test("Given a saved setup handoff, When its Runtime reconnects, Then setup waits and returns a browser-renderable QR code", async ({
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
    expect(connected.qrDataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u);
});
