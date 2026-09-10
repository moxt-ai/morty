import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { AnonymousAccountActions } from "../../src/views/authentication/anonymous-account-actions.tsx";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
});

afterEach(() => vi.useRealTimers());

test("Given an anonymous workspace, When its QR control is opened, Then a one-time mobile transfer is shown with its expiry", async () => {
    const token = `mobius_anon_v1_${"a".repeat(43)}`;
    const screen = await render(
        <AnonymousAccountActions
            token={token}
            createTransfer={async (credential, signal) => {
                signal.throwIfAborted();
                expect(credential).toBe(token);
                return {
                    expiresAt: "2026-09-10T12:15:00.000Z",
                    url: "https://cloud.test/continue#code=transfer-code",
                };
            }}
        />,
    );

    await screen.getByRole("button", { name: "Use this workspace on another device" }).click();
    await expect.element(screen.getByRole("img", { name: "Anonymous workspace transfer QR code" })).toBeVisible();
    await expect.element(screen.getByText(/can be used once/u)).toBeVisible();
});
