import { fireEvent, getAllByRole, getByRole, getByText, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a new visitor, When the setup page opens, Then it presents one clear setup flow and keeps installation details reviewable", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));

    expect(getAllByRole(document.body, "heading")).toHaveLength(1);
    expect(getByRole(document.body, "heading", { level: 1 })).toHaveProperty(
        "textContent",
        "Connect your agent to Morty",
    );
    expect(getByRole(document.body, "region", { name: "Connect your agent to Morty" })).toHaveProperty(
        "className",
        expect.stringContaining("max-w-[460px]"),
    );
    expect(getByRole(document.body, "figure", { name: "Codex, Claude Code, and Pi connect to Morty" })).toBeInstanceOf(
        HTMLElement,
    );
    expect(document.body.textContent).toContain("Run one setup prompt in Codex, Claude Code, or Pi.");
    expect(document.body.textContent).not.toContain("Works with Codex, Claude Code, and Pi.");
    expect(getByText(document.body, "Next: paste it into the agent running on your computer.")).toBeInstanceOf(
        HTMLElement,
    );
    expect(queryByRole(document.body, "list", { name: "Connect your session" })).toBeNull();
    const collapsedDetails = getByRole(document.body, "group", { name: "Setup details" });
    expect(collapsedDetails).toHaveProperty("open", false);
    expect(
        collapsedDetails.contains(getByText(document.body, "Keep that computer awake and online while using Morty.")),
    ).toBe(false);
    expect(
        collapsedDetails.contains(
            getByText(document.body, "Setup may install or update Morty's local connection software."),
        ),
    ).toBe(true);
    expect(queryByRole(document.body, "status", { name: "Setup next step" })).toBeNull();
});

test("Given a new visitor whose agent is busy, When the setup page opens, Then it warns before copying that setup interrupts the agent's current task", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));

    const warning = getByText(
        document.body,
        "Setup interrupts the agent's current task. Continue it in your browser afterwards.",
    );
    expect(getByRole(document.body, "group", { name: "Setup details" }).contains(warning)).toBe(false);
});

test("Given a new visitor, When they copy the instruction, Then the clipboard holds setup and a persistent next step explains where to paste it", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    const copy = await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));

    await app.user.click(copy);
    const instruction = await navigator.clipboard.readText();
    expect(instruction).toContain(`${window.location.origin}/setup.md`);
    const nextStep = getByRole(document.body, "status", { name: "Setup next step" });
    expect(nextStep.textContent).toContain("Paste into your agent, then open the link it returns.");
    await app.user.click(getByText(document.body, "Review setup details", { exact: true }));
    const pairing = getByRole(document.body, "textbox", { name: "Agent setup prompt" });
    expect(pairing).toHaveProperty("value", instruction);
    await app.user.click(pairing);
    expect(getByRole(document.body, "status", { name: "Setup next step" })).toBe(nextStep);
});

test("Given the first screen, When the user reaches the copy button by keyboard and activates it, Then the clipboard holds the full instruction and the button reports Copied", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    const copy = await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));
    expect(document.activeElement).not.toBe(copy);

    copy.focus();
    await app.user.keyboard("{Enter}");

    const instruction = await navigator.clipboard.readText();
    expect(instruction).toContain(`${window.location.origin}/setup.md`);
    await app.user.click(getByText(document.body, "Review setup details", { exact: true }));
    expect(getByRole(document.body, "textbox", { name: "Agent setup prompt" })).toHaveProperty("value", instruction);
    expect(getByRole(document.body, "button", { name: "Copied" })).toBeInstanceOf(HTMLButtonElement);
    expect(document.body.textContent).toContain("Paste into your agent, then open the link it returns.");
});

test("Given a user wants to inspect or manually copy setup, When they expand the instruction, Then they can select its full text and read the local execution details", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));
    await app.user.click(getByText(document.body, "Review setup details", { exact: true }));
    expect(getByRole(document.body, "group", { name: "Setup details" })).toHaveProperty("open", true);

    const pairing = getByRole(document.body, "textbox", { name: "Agent setup prompt" });
    if (!(pairing instanceof HTMLTextAreaElement)) {
        throw new Error("Expected a selectable setup instruction");
    }
    await app.user.click(pairing);

    expect(pairing.readOnly).toBe(true);
    expect(pairing.value).toContain(`${window.location.origin}/setup.md`);
    expect(pairing.selectionStart).toBe(0);
    expect(pairing.selectionEnd).toBe(pairing.value.length);
    expect(document.body.textContent).toContain("Keep that computer awake and online while using Morty.");
    expect(document.body.textContent).toContain("Setup may install or update Morty's local connection software.");
});

test("Given the first screen, When the user clicks Copy again after success, Then the instruction is copied again", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });

    await app.user.click(
        await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" })),
    );
    const copied = getByRole(document.body, "button", { name: "Copied" });
    const instruction = await navigator.clipboard.readText();
    expect(instruction).toContain(`${window.location.origin}/setup.md`);

    await app.user.click(copied);

    expect(await navigator.clipboard.readText()).toBe(instruction);
    expect(getByRole(document.body, "button", { name: "Copied" })).toBeInstanceOf(HTMLButtonElement);
});

test("Given the setup prompt was just copied, When its confirmation animation completes, Then the copy button returns to its default affordance and can copy again", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    const copy = await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));

    await act(async () => {
        fireEvent.click(copy);
    });
    expect(await navigator.clipboard.readText()).toContain(`${window.location.origin}/setup.md`);
    const copied = getByRole(document.body, "button", { name: "Copied" });
    expect(copied).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
        fireEvent.animationEnd(copied, { animationName: "copy-confirmation" });
    });
    const restored = getByRole(document.body, "button", { name: "Copy setup prompt" });
    expect(restored).toBeInstanceOf(HTMLButtonElement);
    expect(getByRole(document.body, "status", { name: "Setup next step" }).textContent).toContain(
        "Paste into your agent, then open the link it returns.",
    );

    await act(async () => {
        fireEvent.click(restored);
    });
    expect(getByRole(document.body, "button", { name: "Copied" })).toBeInstanceOf(HTMLButtonElement);
});
