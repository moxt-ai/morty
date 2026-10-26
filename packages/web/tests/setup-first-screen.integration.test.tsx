import { getAllByRole, getByRole, getByText, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a new visitor, When the setup page opens, Then it explains working with their agent from any browser and where to send the setup prompt", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));

    expect(getAllByRole(document.body, "heading")).toHaveLength(1);
    expect(getByRole(document.body, "heading", { level: 1 })).toHaveProperty("textContent", "Just one prompt.");
    expect(document.body.textContent).toContain("Connect your agent. Continue from any browser.");
    expect(document.body.textContent).toContain("Works with Codex, Claude Code, and Pi.");
    expect(getByText(document.body, "Paste the prompt into the agent on your computer.")).toBeInstanceOf(HTMLElement);
    expect(queryByRole(document.body, "figure")).toBeNull();
    expect(queryByRole(document.body, "list", { name: "Connect your session" })).toBeNull();
    expect(getByRole(document.body, "group", { name: "Setup prompt" })).toHaveProperty("open", false);
    expect(queryByRole(document.body, "status", { name: "Setup next step" })).toBeNull();
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
    await app.user.click(getByText(document.body, "View setup prompt", { exact: true }));
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
    await app.user.click(getByText(document.body, "View setup prompt", { exact: true }));
    expect(getByRole(document.body, "textbox", { name: "Agent setup prompt" })).toHaveProperty("value", instruction);
    expect(getByRole(document.body, "button", { name: "Copied" })).toBeInstanceOf(HTMLButtonElement);
    expect(document.body.textContent).toContain("Paste into your agent, then open the link it returns.");
});

test("Given a user wants to inspect or manually copy setup, When they expand the instruction, Then they can select its full text and read the local execution details", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    await app.waitForView(() => getByRole(document.body, "button", { name: "Copy setup prompt" }));
    await app.user.click(getByText(document.body, "View setup prompt", { exact: true }));
    expect(getByRole(document.body, "group", { name: "Setup prompt" })).toHaveProperty("open", true);

    const pairing = getByRole(document.body, "textbox", { name: "Agent setup prompt" });
    if (!(pairing instanceof HTMLTextAreaElement)) {
        throw new Error("Expected a selectable setup instruction");
    }
    await app.user.click(pairing);

    expect(pairing.readOnly).toBe(true);
    expect(pairing.value).toContain(`${window.location.origin}/setup.md`);
    expect(pairing.selectionStart).toBe(0);
    expect(pairing.selectionEnd).toBe(pairing.value.length);
    expect(document.body.textContent).toContain(
        "Your agent keeps running on its original computer. Keep it awake and online.",
    );
    expect(document.body.textContent).toContain("Setup may install or update the local connection software.");
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
