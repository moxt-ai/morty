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
 * Chat Worker and takes the bridge endpoint away once Chat is open. That is the
 * only way to exercise a reconnect budget that is genuinely spent.
 */
test("Given a bridge endpoint that disappears, When every reconnect attempt fails, Then Chat shows an operable inline Reconnect instead of staying loading", {
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
    // Chat keeps its content while the bridge is still retrying.
    expect(app.optionalElementByTestId(dataTestId.sessionLoadFailure)).toBeNull();
    for (const delay of RECONNECT_DELAYS_MILLISECONDS) {
        await act(async () => {
            clock.advanceBy(delay);
        });
    }

    const failure = await app.waitForView(() => app.elementByTestId(dataTestId.sessionLoadFailure));
    expect(failure.textContent).toContain("The WebSocket to Morty");
    const reconnect = await app.waitForView(() => {
        const button = getByRole(document.body, "button", { name: "Reconnect" });
        expect(button.hasAttribute("disabled")).toBe(false);
        return button;
    });
    // The action is operable: it issues a fresh attempt instead of leaving the
    // page stuck on the skeleton or on a dead end.
    await app.user.click(reconnect);
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.sessionLoadFailure).textContent).toContain("The WebSocket to Morty"),
    );
});
