import { getByRole } from "@testing-library/dom";
import { act, fireEvent } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given the chat sidebar, When the user clicks an icon action and closes what it opened, Then the action releases focus", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true } });
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));

    const share = await app.queryElementByTestId(dataTestId.shareIdentity);
    await app.user.click(share);
    const sharing = getByRole(document.body, "dialog", { name: "Continue on another device" });
    await app.user.click(getByRole(sharing, "button", { name: "Close dialog" }));
    expect(document.activeElement).not.toBe(share);

    const bug = getByRole(document.body, "button", { name: "Report a bug" });
    await app.user.click(bug);
    const bugReport = getByRole(document.body, "dialog", { name: "Report a bug" });
    await app.user.click(getByRole(bugReport, "button", { name: "Close dialog" }));
    expect(document.activeElement).not.toBe(bug);

    const userMenu = await app.queryElementByTestId(dataTestId.userMenu);
    await app.user.click(userMenu);
    await app.waitForView(() => getByRole(document.body, "menuitem", { name: "Network latency" }));
    // The outside pointer that dismisses a menu must not hand focus back to its trigger.
    fireEvent.pointerDown(document.body);
    expect(document.activeElement).not.toBe(userMenu);
});

test("Given the chat sidebar, When a keyboard user opens and closes sharing, Then focus returns to the action", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ page: { kind: "bootstrap", identity: true } });
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));

    const share = await app.queryElementByTestId(dataTestId.shareIdentity);
    // happy-dom does not synthesize a click from Enter, so activate the focused
    // action directly; a keyboard-activated click carries no pointer detail.
    share.focus();
    await act(async () => {
        share.click();
    });
    const sharing = getByRole(document.body, "dialog", { name: "Continue on another device" });
    await app.user.keyboard("{Escape}");
    expect(document.body.contains(sharing)).toBe(false);
    expect(document.activeElement).toBe(share);
});
