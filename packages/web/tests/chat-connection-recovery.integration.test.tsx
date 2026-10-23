import { getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

async function recoverChat(app: TestApp, clock: TestClock, delayMs = 1_000): Promise<void> {
    await act(async () => {
        const connected = app.transport.waitForBridge(AbortSignal.timeout(10_000));
        clock.advanceBy(delayMs);
        await connected;
    });
}

test("Given a connected Chat with an unsent draft, When its network drops and returns, Then it recovers without a blocking dialog or sending the draft and still reports Runtime changes", {
    timeout: 45_000,
}, async () => {
    const clock = new TestClock("2026-10-23T08:00:00Z");
    const app = await createTestApp({ connectAgent: true, clock });
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(composer instanceof HTMLTextAreaElement) || app.daemon === null) {
        throw new Error("Expected the connected Chat and Runtime");
    }
    await app.user.click(composer);
    await app.user.paste("Keep this draft unsent");

    app.transport.disconnect();
    expect(queryByRole(document.body, "dialog")).toBeNull();
    expect(composer.value).toBe("Keep this draft unsent");

    await recoverChat(app, clock);
    expect(composer.value).toBe("Keep this draft unsent");
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("Keep this draft unsent");

    // This needs the restored configuration watch, not merely an open socket.
    await app.daemon.disconnect();
    await app.waitForView(() => expect(document.body.textContent).toContain("Your agent is disconnected"), 30_000);
    expect(app.elementByTestId(dataTestId.messageComposer)).toBe(composer);
    expect(composer.value).toBe("Keep this draft unsent");
    expect(queryByRole(document.body, "dialog")).toBeNull();
});

test("Given a draft on an open Chat, When its bridge repeatedly disconnects and recovers, Then the same composer keeps the draft without sending it", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock("2026-10-23T08:00:00Z");
    const app = await createTestApp({ connectAgent: true, clock });
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the draft composer");
    }
    await app.user.click(composer);
    await app.user.paste("Do not resend this draft");
    // Repeated drops before a healthy interval retain the bounded backoff.
    for (const delayMs of [1_000, 2_000, 4_000]) {
        app.transport.disconnect();
        expect(queryByRole(document.body, "dialog")).toBeNull();
        await recoverChat(app, clock, delayMs);
        expect(app.elementByTestId(dataTestId.messageComposer)).toBe(composer);
        expect(composer.value).toBe("Do not resend this draft");
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain(
            "Do not resend this draft",
        );
    }
});

test("Given a running task and an unsent draft, When Chat disconnects while the task completes, Then recovery preserves the result and restores subsequent updates", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock("2026-10-23T08:00:00Z");
    const app = await createTestApp({ connectAgent: true, clock });
    const initialComposer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(initialComposer instanceof HTMLTextAreaElement) || app.daemon === null) {
        throw new Error("Expected a connected Chat and Runtime");
    }
    await sendPrompt(app, initialComposer, "hold after first delta");
    await app.waitForView(() =>
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain("Partial reply"),
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the session composer");
    }
    await app.user.click(composer);
    await app.user.paste("My unsent follow-up");
    app.transport.disconnect();
    await app.daemon.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "text", text: "Finished during the Chat interruption" }],
    });
    await recoverChat(app, clock);
    await app.waitForView(() => {
        expect(queryByRole(document.body, "dialog")).toBeNull();
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Finished during the Chat interruption",
        );
        expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
    });
    expect(composer.value).toBe("My unsent follow-up");
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("My unsent follow-up");
    await app.user.clear(composer);
    await sendPrompt(app, composer, "A new explicit request");
    await app.waitForView(() =>
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Codex turn 2: A new explicit request",
        ),
    );
});
