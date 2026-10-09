import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a Codex native session handoff, When the user hovers over import, Then import is disabled and explains that Codex does not support it", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: {
            harness: "codex",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });
    const importSession = await vi.waitFor(() => getByRole(document.body, "button", { name: "Import session" }));
    const forkSession = getByRole(document.body, "button", { name: "Fork session" });
    if (!(importSession instanceof HTMLButtonElement) || !(forkSession instanceof HTMLButtonElement)) {
        throw new Error("The native session actions are not buttons.");
    }

    expect(importSession.disabled).toBe(true);
    expect(forkSession.disabled).toBe(false);

    await app.user.hover(getByRole(document.body, "group", { name: "Why import is unavailable" }));

    expect(
        await vi.waitFor(() =>
            getByRole(document.body, "tooltip", { name: "codex doesn't support import conversation" }),
        ),
    ).toBeInstanceOf(HTMLElement);
});

test("Given a native session handoff, When importing fails, Then the choice page shows progress and allows a fork retry", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: {
            harness: "opencode",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });
    const importSession = await vi.waitFor(() => getByRole(document.body, "button", { name: "Import session" }));
    const forkSession = getByRole(document.body, "button", { name: "Fork session" });
    if (!(importSession instanceof HTMLButtonElement) || !(forkSession instanceof HTMLButtonElement)) {
        throw new Error("The native session actions are not buttons.");
    }

    await app.user.click(importSession);

    expect(importSession.disabled).toBe(true);
    expect(forkSession.disabled).toBe(true);
    expect(getByRole(importSession, "status", { name: "Importing session" })).toBeInstanceOf(HTMLElement);
    expect(queryByRole(document.body, "status", { name: "Securely transferring the workspace" })).toBeNull();

    await vi.waitFor(() => expect(getByRole(document.body, "alert")).toBeInstanceOf(HTMLElement));
    expect(getByRole(document.body, "heading", { name: "Continue native session" })).toBeInstanceOf(HTMLElement);
    expect(importSession.disabled).toBe(false);
    expect(forkSession.disabled).toBe(false);

    await app.user.click(forkSession);

    expect(getByRole(forkSession, "status", { name: "Forking session" })).toBeInstanceOf(HTMLElement);
});

test("Given a shared workspace, When the user opens the user menu, Then they can back up their token before replacing the current user", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    await app.user.click(await app.queryElementByTestId(dataTestId.userMenu));
    await app.user.click(await app.queryElementByTestId(dataTestId.replaceCurrentUser));

    const dialog = await app.queryElementByTestId(dataTestId.replaceCurrentUserDialog);
    expect(dialog.textContent).toContain("Replace current user");
    expect(dialog.textContent).toContain("Back up this token");
    expect(app.elementByTestId(dataTestId.currentUserToken, dialog)).toHaveProperty(
        "value",
        expect.stringMatching(/^mobius_recovery_v1\./u),
    );
    expect(app.elementByTestId(dataTestId.copyUserToken, dialog).getAttribute("aria-label")).toBe(
        "Copy current user token",
    );
    expect(app.elementByTestId(dataTestId.replacementUserToken, dialog).getAttribute("aria-label")).toBe(
        "Replacement user token",
    );
});

test("Given a connected shared workspace, When the user refreshes Network Diagnostic, Then both latency measurements update", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.userMenu));
    await app.user.click(getByRole(document.body, "menuitem", { name: "Network Diagnostic" }));

    const dialog = getByRole(document.body, "dialog", { name: "Network Diagnostic" });
    await vi.waitFor(() => {
        expect(dialog.textContent).toContain("Browser ↔ Relay");
        expect(dialog.textContent).toContain("Relay ↔ Daemon");
        expect(getByRole(dialog, "status", { name: "Browser to relay latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Relay to daemon latency" }).textContent).toMatch(/^\d+ ms$/u);
    });

    await app.user.click(getByRole(dialog, "button", { name: "Refresh network diagnostic" }));

    expect(getByRole(dialog, "status", { name: "Measuring network latency" })).toBeInstanceOf(HTMLElement);
    await vi.waitFor(() => {
        expect(getByRole(dialog, "status", { name: "Browser to relay latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Relay to daemon latency" }).textContent).toMatch(/^\d+ ms$/u);
    });
});

test("Given a shared workspace, When the user chooses to end remote access from the user menu, Then they must confirm the transfer-wide revocation and can back up their token", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    const shareMachine = await app.queryElementByTestId(dataTestId.shareMachine);

    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    const userMenu = await app.queryElementByTestId(dataTestId.userMenu);
    expect(userMenu.parentElement).toBe(shareMachine.parentElement);
    await app.user.click(userMenu);
    const endAccess = await app.queryElementByTestId(dataTestId.endRemoteAccess);
    await app.user.click(endAccess);

    const dialog = await app.queryElementByTestId(dataTestId.endRemoteAccessDialog);
    expect(dialog.textContent).toContain("End remote access?");
    expect(dialog.textContent).toContain("every browser using this access link");
    expect(dialog.textContent).toContain("Your local Runtime and task will keep running");
    expect(dialog.textContent).toContain("Back up this token");
    expect(app.elementByTestId(dataTestId.currentUserToken, dialog)).toHaveProperty(
        "value",
        expect.stringMatching(/^mobius_recovery_v1\./u),
    );
    expect(dialog.textContent).toContain("Cancel");
    expect(dialog.textContent).toContain("End remote access");
});
