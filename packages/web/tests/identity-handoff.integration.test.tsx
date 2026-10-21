import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a native session handoff, When the page loads, Then it tells the user the session is opening instead of offering choices and a QR code", {
    timeout: 30_000,
}, async () => {
    const sessionId = "01a0d270-0d62-7003-98df-22a5d11dc644";
    const app = await createTestApp({
        agent: { id: "pi", label: "Pi" },
        connectAgent: true,
        nativeSessionIds: new Set([sessionId]),
        page: { harness: "pi", kind: "continue", sessionId },
    });

    expect(await app.waitForView(() => getByRole(document.body, "status", { name: "Opening session" }))).toBeInstanceOf(
        HTMLElement,
    );
    expect(document.body.textContent).toContain("Opening the original session in Morty.");
    expect(queryByRole(document.body, "button", { name: "Open session" })).toBeNull();
    expect(queryByRole(document.body, "button", { name: "Fork session" })).toBeNull();
    expect(queryByRole(document.body, "img", { name: "QR code to continue on another device" })).toBeNull();
    expect(queryByRole(document.body, "button", { name: "Show QR code" })).toBeNull();
});

test("Given a native session handoff, When the page loads, Then it shows no site header and no entry back to Morty home", {
    timeout: 30_000,
}, async () => {
    const sessionId = "01a0d270-0d62-7003-98df-22a5d11dc644";
    const app = await createTestApp({
        agent: { id: "pi", label: "Pi" },
        connectAgent: true,
        nativeSessionIds: new Set([sessionId]),
        page: { harness: "pi", kind: "continue", sessionId },
    });

    await app.waitForView(() => getByRole(document.body, "heading", { name: "Continue native session" }));
    expect(document.body.textContent).not.toContain("Your agents. Connected.");
    expect(document.body.querySelector("header")).toBeNull();
    expect(queryByRole(document.body, "link")).toBeNull();
});

test("Given a new browser, When Morty loads, Then Morty opens without presenting a workspace concept", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap" } });

    expect(
        await app.waitForView(() => getByRole(document.body, "heading", { name: "Connect your local agent" })),
    ).toBeInstanceOf(HTMLElement);
    expect(document.body.textContent).not.toContain("Local agents");
    expect(document.body.textContent?.toLowerCase()).not.toContain("workspace");
});

test("Given Morty access from a finished setup, When the user reopens Morty in a fresh browser session, Then the chat opens directly with the identity kept in the address", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true }, connectAgent: true });

    expect(await app.queryElementByTestId(dataTestId.chatLanding)).toBeInstanceOf(HTMLElement);
    expect(queryByRole(document.body, "heading", { name: "Connect your local agent" })).toBeNull();
    expect(window.location.search).toContain("identity=");
    expect(window.sessionStorage.getItem("mobius.anonymous-credential.v2")).toBeNull();
});

test("Given shared Morty access, When the user opens Continue your work, Then the icon-only action and dialog use that name", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    const reportBug = await app.waitForView(() => getByRole(document.body, "button", { name: "Report a bug" }));
    const actions = [
        { element: reportBug, tooltip: "Report a bug" },
        { element: await app.queryElementByTestId(dataTestId.userMenu), tooltip: "User menu" },
        { element: await app.queryElementByTestId(dataTestId.shareIdentity), tooltip: "Continue your work" },
    ];

    for (const { element, tooltip } of actions) {
        expect(element.textContent).toBe("");
        await app.user.hover(element);
        expect(await app.waitForView(() => getByRole(document.body, "tooltip", { name: tooltip }))).toBeInstanceOf(
            HTMLElement,
        );
    }

    await app.user.click(getByRole(document.body, "button", { name: "Continue your work" }));

    expect(getByRole(document.body, "dialog", { name: "Continue your work" })).toBeInstanceOf(HTMLElement);
});

test("Given a native session handoff without a matching Agent, When the page loads, Then opening fails with the reason", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: {
            harness: "pi",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });

    const alert = await app.waitForView(() => getByRole(document.body, "alert"));
    expect(alert.textContent).toContain("handoff harness is unavailable");
    expect(getByRole(document.body, "heading", { name: "Continue native session" })).toBeInstanceOf(HTMLElement);
    expect(queryByRole(document.body, "button", { name: "Fork session" })).toBeNull();
});

test("Given opening a native session fails, When the user tries again, Then the page re-runs the same open-session request", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: {
            harness: "pi",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });
    await app.waitForView(() => getByRole(document.body, "alert"));

    await app.user.click(getByRole(document.body, "button", { name: "Try again" }));

    expect(getByRole(document.body, "status", { name: "Opening session" })).toBeInstanceOf(HTMLElement);
    await app.waitForView(() => {
        expect(getByRole(document.body, "alert").textContent).toContain("handoff harness is unavailable");
    });
    expect(getByRole(document.body, "button", { name: "Try again" })).toBeInstanceOf(HTMLButtonElement);
});

test("Given a native session handoff whose Runtime went offline, When the page loads, Then the page reports Mobius is disconnected instead of a transfer-link problem", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        prepare: async (application) => {
            const runtime = await application.connectAgent({ id: "claude", label: "Claude" });
            await runtime.disconnect();
        },
        page: {
            harness: "claude",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });

    const alert = await app.waitForView(() => getByRole(document.body, "alert"));
    expect(alert.textContent).toContain("Your Mobius is disconnected");
    expect(alert.textContent).toContain("Start your Mobius");
    expect(alert.textContent?.toLowerCase()).not.toContain("transfer link");
    expect(getByRole(document.body, "button", { name: "Try again" })).toBeInstanceOf(HTMLButtonElement);
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
    const shareIdentity = await app.queryElementByTestId(dataTestId.shareIdentity);

    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    const userMenu = await app.queryElementByTestId(dataTestId.userMenu);
    expect(userMenu.parentElement).toBe(shareIdentity.parentElement);
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
