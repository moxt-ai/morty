import { queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

const CLOCK_ORIGIN = "2026-10-13T08:00:00Z";
const CONNECTION_DIALOG = "Runtime connection unavailable";

function connectionDialog(): HTMLElement | null {
    return queryByRole(document.body, "dialog", { name: CONNECTION_DIALOG });
}

function agentAnswered(app: Awaited<ReturnType<typeof createTestApp>>, text: string): boolean {
    return app.elementsByTestId(dataTestId.agentResponse).some((message) => message.textContent?.includes(text));
}

test("Given an open conversation, When the Chat WebSocket bridge drops, Then no connection dialog appears and Chat resumes after the bridge reconnects", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    const draft = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    await sendPrompt(app, draft, "Before the bridge drop");
    await app.waitForView(() => expect(agentAnswered(app, "Codex turn 1: Before the bridge drop")).toBe(true));

    app.transport.disconnect();

    // The dropped bridge is an ordinary failed call: Chat keeps the
    // conversation on screen instead of blocking it with a dialog.
    expect(connectionDialog()).toBeNull();
    expect(queryByRole(document.body, "alert")?.textContent ?? "").not.toContain("WebSocket to Morty");
    expect(document.body.textContent).toContain("Before the bridge drop");

    await act(async () => {
        clock.advanceBy(1_000);
    });

    // The transport reconnected on its own, so the composer accepts messages
    // again without a manual retry.
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    await sendPrompt(app, composer, "After the bridge returned");
    await app.waitForView(() => expect(agentAnswered(app, "Codex turn 2: After the bridge returned")).toBe(true));
    expect(connectionDialog()).toBeNull();
});
