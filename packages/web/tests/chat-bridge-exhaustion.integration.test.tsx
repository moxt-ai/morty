import { getByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { ANONYMOUS_CREDENTIAL_KEY_NAME } from "../src/services/identity/anonymous-identity-api.ts";
import { encodeIdentityScope } from "../src/services/identity/identity-scope-url.ts";
import { anonymousCredentialsEntry, centralLocalStorage } from "../src/services/local-storage/central-local-storage.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment } from "./support/chat-worker.ts";

const CLOCK_ORIGIN = "2026-10-13T08:00:00Z";
const RECONNECT_DELAYS_MILLISECONDS = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000];

/**
 * The shared Worker fixture must stay reachable, so this scenario owns its own
 * Chat Worker and takes the bridge endpoint away once Chat is open.
 */
test("Given a bridge endpoint that disappears, When every reconnect attempt fails, Then Chat keeps the conversation instead of replacing the page", {
    timeout: 60_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const environment = await createChatWorkerEnvironment();
    const application = await environment.createApplication(clock);
    const scope = {
        botId: application.botId,
        projectId: application.identity.projectId,
        userId: application.userId,
    };
    window.location.href = `${application.origin}/chat?identity=${encodeURIComponent(encodeIdentityScope(scope))}`;
    window.localStorage.setItem(
        ANONYMOUS_CREDENTIAL_KEY_NAME,
        JSON.stringify({
            ...(centralLocalStorage.read(anonymousCredentialsEntry) ?? {}),
            [application.userId]: await application.identity.getToken(new AbortController().signal),
        }),
    );
    const app = await createTestApp({ application, clock, connectAgent: true, page: { kind: "reload" } });
    await app.waitForView(() =>
        expect(getByRole(document.body, "textbox", { name: "Message" })).toBeInstanceOf(HTMLTextAreaElement),
    );

    await environment.close();
    app.transport.disconnect();
    for (const delay of RECONNECT_DELAYS_MILLISECONDS) {
        await act(async () => {
            clock.advanceBy(delay);
        });
    }

    // The exhausted budget does not rewrite the page: the sidebar, execution
    // context, and composer stay exactly where they were.
    expect(getByRole(document.body, "navigation", { name: "Session actions" })).toBeInstanceOf(HTMLElement);
    expect(getByRole(document.body, "status", { name: "Connection" })).toBeInstanceOf(HTMLElement);
    expect(getByRole(document.body, "textbox", { name: "Message" })).toBeInstanceOf(HTMLTextAreaElement);
    expect(app.optionalElementByTestId(dataTestId.sessionLoadFailure)).toBeNull();
    // No takeover screen and no dialog.
    expect(
        app.elementsByTestId(dataTestId.chatLanding).every((element) => element.textContent?.includes("Morty")),
    ).toBe(true);

    // A user action then surfaces the failure through the ordinary
    // draft-settings path, exactly where any other failed load appears.
    await app.user.click(getByRole(document.body, "button", { name: "New Session" }));
    const reported = await app.waitForView(() => {
        const alerts = [...document.querySelectorAll<HTMLElement>('[role="alert"]')];
        const match = alerts.find((element) => element.textContent?.includes("WebSocket to Morty"));
        if (match === undefined) {
            throw new Error("Waiting for the bridge failure to surface");
        }
        return match;
    });
    expect(reported.textContent).toContain("WebSocket to Morty");
    // The ordinary retry action stays reachable alongside the message.
    expect(getByRole(document.body, "button", { name: /Retry settings|Try again/ })).toBeInstanceOf(HTMLButtonElement);
});
