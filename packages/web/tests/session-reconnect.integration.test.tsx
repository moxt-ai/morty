import { queryByRole } from "@testing-library/dom";
import { expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

function reconnectStatusText(app: TestApp): string | null {
    const notice = app.optionalElementByTestId(dataTestId.sessionReconnectNotice);
    if (notice === null) {
        return null;
    }
    return queryByRole(notice, "status")?.textContent ?? null;
}

test("Given a session whose Runtime goes offline, When the live event stream cannot recover, Then the pane shows the failure with a retry countdown, reconnects automatically, and shows the failure with a retry time again", {
    timeout: 90_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    const prompt = "Survive a Runtime restart";
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true),
        ).toBe(true),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected the connected Agent Runtime");
    }
    await daemon.disconnect();

    const countdown = /^Retrying in [1-9]\d* s Retry now$/u;
    await vi.waitFor(() => expect(reconnectStatusText(app)).toMatch(countdown), { interval: 250, timeout: 30_000 });
    const notice = app.elementByTestId(dataTestId.sessionReconnectNotice);
    const composerForm = notice.closest("form");
    if (composerForm === null) {
        throw new Error("Expected the retry status beside the composer");
    }
    expect(queryByRole(composerForm, "alert")?.textContent).toContain("could not recover");
    expect(composerForm.textContent).toMatch(/could not recover[\s\S]*Retrying in [1-9]\d* s Retry now/u);
    const retryNow = queryByRole(notice, "button", { name: "Retry now" });
    if (!(retryNow instanceof HTMLButtonElement)) {
        throw new Error("Expected the Retry now button");
    }
    await app.user.click(retryNow);

    await vi.waitFor(() => expect(reconnectStatusText(app)).toContain("Mobius is reconnecting"), {
        interval: 250,
        timeout: 30_000,
    });

    await vi.waitFor(() => expect(reconnectStatusText(app)).toMatch(countdown), { interval: 250, timeout: 30_000 });
});
