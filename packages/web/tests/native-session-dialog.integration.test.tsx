import { fireEvent, getAllByRole, getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given Chat is ready, When the user views recent sessions and opens a local session, Then every action uses session terminology", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    expect(getByRole(document.body, "heading", { name: "Recent sessions" })).toBeDefined();
    expect(getByRole(document.body, "button", { name: "New Session" })).toBeDefined();
    const open = getByRole(document.body, "button", { name: "Open Session" });
    const discovering = app.waitForView(() => {
        const status = queryByRole(document.body, "status", {
            name: "Discovering native sessions",
        });
        if (status === null) {
            throw new Error("The native session loading placeholder is not visible.");
        }
        return status;
    });

    await app.user.click(open);

    await discovering;
    const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    await app.waitForView(() => {
        if (queryByRole(dialog, "status", { name: "Discovering native sessions" }) !== null) {
            throw new Error("The native session dialog is still discovering sessions.");
        }
        return getByRole(dialog, "button", { name: "Open" });
    });
    expect(queryByRole(dialog, "button", { name: "Import" })).toBeNull();
    const preview = getByRole(document.body, "region", {
        name: "Selected session preview",
    });
    expect(preview.textContent).toContain("Select a session");
    expect(preview.textContent).toContain("Preview its message history here.");
});

test("Given Pi is not installed on the Runtime, When the user opens Open Session and selects Pi, Then the dialog explains Pi is not installed", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    const tablist = await app.waitForView(() => getByRole(dialog, "tablist", { name: "Session agent" }));
    const pi = getByRole(tablist, "tab", { name: "Pi" });
    await app.user.click(pi);
    await app.waitForView(() => {
        expect(dialog.textContent).toContain("Pi is not installed");
        expect(dialog.textContent).toContain("Install it on this machine to browse saved sessions.");
    });
});

test("Given Pi is installed on the Runtime, When the user opens Open Session, Then Pi appears once in the agent tabs", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, agent: { id: "pi", label: "Pi" } });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    const tablist = await app.waitForView(() => getByRole(dialog, "tablist", { name: "Session agent" }));
    expect(getAllByRole(tablist, "tab", { name: "Pi" })).toHaveLength(1);
});

test("Given native sessions are available, When the user selects a session from the Native session menu, Then its history is previewed", {
    timeout: 30_000,
}, async () => {
    const longSessionId = "session-two-with-a-title-that-is-long-enough-to-overflow-a-mobile-menu";
    const longSessionTitle = `Native ${longSessionId}`;
    const app = await createTestApp({
        connectAgent: true,
        nativeSessionIds: new Set(["session-one", longSessionId]),
    });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const menu = await app.waitForView(() =>
        getByRole(document.body, "combobox", {
            name: "Native session",
        }),
    );

    await app.user.click(menu);
    const longSession = getByRole(document.body, "option", {
        name: /Native session-two-with-a-title-that-is-long-enough-to-overflow-a-mobile-menu/,
    });
    expect(longSession.getAttribute("title")).toBe(`${longSessionTitle} · /`);
    act(() => fireEvent.click(longSession));

    const preview = getByRole(document.body, "region", {
        name: "Selected session preview",
    });
    await app.waitForView(() => getByRole(preview, "heading", { name: longSessionTitle }));
});
