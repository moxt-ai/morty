import { getAllByRole, getByRole } from "@testing-library/dom";
import { expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a browser without a finished setup, When the first screen opens, Then it presents phone continuation above a single copy action", {
    timeout: 30_000,
}, async () => {
    await createTestApp({ page: { kind: "bootstrap" } });

    expect(
        await vi.waitFor(() =>
            getByRole(document.body, "heading", { level: 1, name: "Continue your coding session from your phone." }),
        ),
    ).toBeInstanceOf(HTMLElement);
    expect(document.body.textContent).toContain(
        "Check progress, send instructions, and approve requests while your agent runs on your computer.",
    );
    expect(document.body.textContent).toContain("Works with Codex, Claude Code, and Pi.");
    expect(getByRole(document.body, "heading", { level: 2, name: "Start on your computer" })).toBeInstanceOf(
        HTMLElement,
    );
    expect(document.body.textContent).toContain(
        "Paste the instruction below into the coding agent session you want to continue. Then open the link it returns on your phone or in another browser.",
    );
    expect(document.body.textContent).toContain("Local execution. Remote access you can revoke.");
    expect(document.body.textContent).toContain(
        "Keep your computer awake and online. Setup may install or update the local connection software.",
    );
    expect(getAllByRole(document.body, "button")).toHaveLength(1);
    expect(getByRole(document.body, "button", { name: "Copy setup instruction" })).toBeInstanceOf(HTMLButtonElement);
    const pairing = document.body.querySelector(`[data-testid="${dataTestId.pairingInstruction}"]`);
    if (!(pairing instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the setup instruction to stay a selectable text area");
    }
    expect(pairing.value).toBe(
        `Fetch ${window.location.origin}/setup.md and set up Morty for me. Don't ask me anything.`,
    );
});

test("Given the first screen, When the user reaches the copy button by keyboard and activates it, Then the clipboard holds the full instruction and the button reports Copied", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    const instruction = `Fetch ${window.location.origin}/setup.md and set up Morty for me. Don't ask me anything.`;
    const copy = await vi.waitFor(() => getByRole(document.body, "button", { name: "Copy setup instruction" }));
    expect(document.activeElement).not.toBe(copy);

    copy.focus();
    await app.user.keyboard("{Enter}");

    expect(await navigator.clipboard.readText()).toBe(instruction);
    expect(getByRole(document.body, "button", { name: "Copied" })).toBeInstanceOf(HTMLButtonElement);
    expect(document.body.textContent).toContain(
        "Paste it into your coding agent on your computer, then open the link it returns.",
    );
});

test("Given the first screen, When the user focuses the instruction, Then the whole instruction becomes selected for manual copy", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    await vi.waitFor(() =>
        getByRole(document.body, "heading", { level: 1, name: "Continue your coding session from your phone." }),
    );

    const pairing = app.elementByTestId(dataTestId.pairingInstruction);
    if (!(pairing instanceof HTMLTextAreaElement)) {
        throw new Error("Expected a selectable setup instruction");
    }
    await app.user.click(pairing);

    expect(pairing.readOnly).toBe(true);
    expect(pairing.selectionStart).toBe(0);
    expect(pairing.selectionEnd).toBe(pairing.value.length);
});

test("Given the first screen, When the user clicks Copy again after success, Then the instruction is copied again", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });
    const instruction = `Fetch ${window.location.origin}/setup.md and set up Morty for me. Don't ask me anything.`;

    await app.user.click(
        await vi.waitFor(() => getByRole(document.body, "button", { name: "Copy setup instruction" })),
    );
    const copied = getByRole(document.body, "button", { name: "Copied" });
    expect(await navigator.clipboard.readText()).toBe(instruction);

    await app.user.click(copied);

    expect(await navigator.clipboard.readText()).toBe(instruction);
    expect(getByRole(document.body, "button", { name: "Copied" })).toBeInstanceOf(HTMLButtonElement);
});
