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
            getByRole(document.body, "tooltip", { name: "codex doesn't support importing sessions" }),
        ),
    ).toBeInstanceOf(HTMLElement);
});

test("Given a native session handoff, When the choice page loads, Then a QR code of the same page is offered for another device", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: {
            harness: "pi",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });
    const qrCode = await vi.waitFor(() =>
        getByRole(document.body, "img", { name: "QR code to continue on another device" }),
    );

    expect(qrCode.getAttribute("src")).toMatch(/^data:image\/png/u);

    await app.user.click(getByRole(document.body, "button", { name: "Show QR code" }));

    const dialog = await vi.waitFor(() => getByRole(document.body, "dialog", { name: "Continue on another device" }));
    const dialogQrCode = await vi.waitFor(() =>
        getByRole(dialog, "img", { name: "QR code to continue on another device" }),
    );

    expect(dialogQrCode.getAttribute("src")).toBe(qrCode.getAttribute("src"));
});

test("Given a new browser, When Morty loads, Then Morty opens without presenting a workspace concept", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });

    expect(await app.queryElementByTestId(dataTestId.closeDialog)).toBeInstanceOf(HTMLElement);
    expect(document.body.textContent).not.toContain("Local agents");
    expect(document.body.textContent?.toLowerCase()).not.toContain("workspace");
});

test("Given shared Morty access, When the user opens Continue your work, Then the icon-only action and dialog use that name", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    const reportBug = await vi.waitFor(() => getByRole(document.body, "button", { name: "Report a bug" }));
    const actions = [
        { element: reportBug, tooltip: "Report a bug" },
        { element: await app.queryElementByTestId(dataTestId.userMenu), tooltip: "User menu" },
        { element: await app.queryElementByTestId(dataTestId.shareMachine), tooltip: "Continue your work" },
    ];

    for (const { element, tooltip } of actions) {
        expect(element.textContent).toBe("");
        await app.user.hover(element);
        expect(await vi.waitFor(() => getByRole(document.body, "tooltip", { name: tooltip }))).toBeInstanceOf(
            HTMLElement,
        );
    }

    await app.user.click(getByRole(document.body, "button", { name: "Continue your work" }));

    expect(getByRole(document.body, "dialog", { name: "Continue your work" })).toBeInstanceOf(HTMLElement);
});

test("Given a native session handoff, When importing fails, Then the choice page shows progress and allows a fork retry", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: {
            harness: "pi",
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
    expect(queryByRole(document.body, "status", { name: "Securely transferring Morty access" })).toBeNull();

    await vi.waitFor(() => expect(getByRole(document.body, "alert")).toBeInstanceOf(HTMLElement));
    expect(getByRole(document.body, "heading", { name: "Continue native session" })).toBeInstanceOf(HTMLElement);
    expect(importSession.disabled).toBe(false);
    expect(forkSession.disabled).toBe(false);

    await app.user.click(forkSession);

    expect(getByRole(forkSession, "status", { name: "Forking session" })).toBeInstanceOf(HTMLElement);
});

test("Given shared Morty access, When the user opens the user menu, Then replacing the current user is unavailable", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    await app.user.click(await app.queryElementByTestId(dataTestId.userMenu));

    expect(queryByRole(document.body, "menuitem", { name: "Replace current user" })).toBeNull();
});

test("Given connected shared Morty access, When the user refreshes Network latency, Then every network hop latency updates", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.userMenu));
    await app.user.click(getByRole(document.body, "menuitem", { name: "Network latency" }));

    const dialog = getByRole(document.body, "dialog", { name: "Network latency" });
    await app.waitForView(() => {
        expect(dialog.textContent).toContain("Mobius location: Western North America");
        expect(dialog.textContent).toContain("Browser ↔ Morty");
        expect(dialog.textContent).toContain("Browser ↔ Mobius");
        expect(dialog.textContent).toContain("Morty ↔ Mobius");
        expect(dialog.textContent).toContain("Mobius ↔ Daemon");
        expect(getByRole(dialog, "status", { name: "Browser to Morty latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Browser to Mobius latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Morty to Mobius latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Mobius to daemon latency" }).textContent).toMatch(/^\d+ ms$/u);
    });

    await app.user.click(getByRole(dialog, "button", { name: "Refresh network latency" }));

    expect(getByRole(dialog, "status", { name: "Measuring network latency" })).toBeInstanceOf(HTMLElement);
    await app.waitForView(() => {
        expect(getByRole(dialog, "status", { name: "Browser to Morty latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Browser to Mobius latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Morty to Mobius latency" }).textContent).toMatch(/^\d+ ms$/u);
        expect(getByRole(dialog, "status", { name: "Mobius to daemon latency" }).textContent).toMatch(/^\d+ ms$/u);
    });
});

test("Given shared Morty access, When the user chooses to end remote access from the user menu, Then they confirm the transfer-wide revocation without a recovery code", {
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
    expect(dialog.textContent).not.toContain("Back up this token");
    expect(queryByRole(dialog, "textbox", { name: "Current user token" })).toBeNull();
    expect(dialog.textContent).toContain("Cancel");
    expect(dialog.textContent).toContain("End remote access");
});
