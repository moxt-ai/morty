import { getByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment } from "./support/chat-worker.ts";

function entry(app: TestApp, title: string) {
    const item = app.elementsByTestId(dataTestId.managedConversation).find((e) => e.textContent?.includes(title));
    if (!item) {
        throw new Error(`Missing session ${title}`);
    }
    return item;
}
function status(app: TestApp, title: string) {
    return (
        entry(app, title).querySelector(`[data-testid="${dataTestId.sessionStatus}"]`)?.getAttribute("aria-label") ??
        null
    );
}
test("Given a background Session's failed status, When another viewer completes a later turn while my Chat bridge is disconnected, Then reconnect clears the old failed status", {
    timeout: 60000,
}, async () => {
    const environment = await createChatWorkerEnvironment();
    onTestFinished(() => environment.close());
    const clock = new TestClock("2026-11-09T08:00:00Z");
    const first = await createTestApp({ environment, clock, connectAgent: true });
    await sendPrompt(first, await first.queryElementByTestId(dataTestId.messageComposer), "Established session");
    await first.waitForView(() => expect(first.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull());
    await sendPrompt(first, await first.queryElementByTestId(dataTestId.messageComposer), "fail this turn explicitly");
    await first.waitForView(() => expect(status(first, "Established session")).toBe("Session failed"));
    await first.user.click(await first.queryElementByTestId(dataTestId.newConversation));
    await sendPrompt(first, await first.queryElementByTestId(dataTestId.messageComposer), "Other session");
    await first.waitForView(() => {
        expect(first.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Other session");
        expect(first.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    const firstComposer = first.elementByTestId(dataTestId.messageComposer);
    await first.user.click(firstComposer);
    await first.user.paste("Draft survives reconnect");
    const form = firstComposer.closest("form");
    if (!form) {
        throw new Error("Missing composer form");
    }
    const other = await first.openViewer();
    await other.user.click(await other.waitForView(() => entry(other, "Established session")));
    const otherComposer = await other.queryElementByTestId(
        dataTestId.messageComposer,
        (e) => e instanceof HTMLTextAreaElement && !e.disabled,
    );
    first.transport.disconnect();
    await first.waitForView(() =>
        expect(getByRole(form, "button", { name: "Send message" })).toHaveProperty("disabled", true),
    );
    await sendPrompt(other, otherComposer, "Recovery completed");
    await other.waitForView(() => {
        expect(other.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Recovery completed");
        expect(other.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        expect(status(other, "Established session")).toBeNull();
    });
    await act(async () => clock.advanceBy(1000));
    await first.waitForView(() =>
        expect(getByRole(form, "button", { name: "Send message" })).toHaveProperty("disabled", false),
    );
    await first.waitForView(() => expect(status(first, "Established session")).toBeNull());
});
