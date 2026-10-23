import { getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

async function recoverChat(app: TestApp, clock: TestClock): Promise<void> {
    for (const attempt of [1, 2, 3]) {
        const reconnecting = await app.waitForView(() => {
            const notice = queryByRole(document.body, "status", { name: "Chat connection" });
            if (notice === null) {
                return false;
            }
            expect(notice.textContent).toContain(`Attempt ${attempt} of 3`);
            return true;
        });
        if (!reconnecting) {
            return;
        }
        await act(async () => clock.advanceBy(1000 * 2 ** (attempt - 1)));
    }
    await app.waitForView(() => expect(queryByRole(document.body, "status", { name: "Chat connection" })).toBeNull());
}

test("Given a connected Chat with an unsent draft, When its network drops and returns, Then it recovers without a blocking dialog or sending the draft and still reports Runtime changes", {
    timeout: 45_000,
}, async () => {
    const clock = new TestClock("2026-10-23T08:00:00Z");
    const app = await createTestApp({ connectAgent: true, interruptibleChat: true, clock });
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(composer instanceof HTMLTextAreaElement) || app.chatNetwork === null || app.daemon === null) {
        throw new Error("Expected the connected Chat and Runtime");
    }
    await app.user.click(composer);
    await app.user.paste("Keep this draft unsent");

    app.chatNetwork.disconnect();
    await app.waitForView(() =>
        expect(getByRole(document.body, "status", { name: "Chat connection" }).textContent).toContain(
            "Reconnecting to Chat",
        ),
    );
    expect(queryByRole(document.body, "dialog")).toBeNull();
    expect(composer.value).toBe("Keep this draft unsent");

    app.chatNetwork.reconnect();
    await recoverChat(app, clock);
    await app.waitForView(() => expect(queryByRole(document.body, "status", { name: "Chat connection" })).toBeNull());
    expect(composer.value).toBe("Keep this draft unsent");
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("Keep this draft unsent");

    // This needs the restored configuration watch, not merely an open socket.
    await app.daemon.disconnect();
    await app.waitForView(() => expect(document.body.textContent).toContain("Your agent is disconnected"), 30_000);
    expect(app.elementByTestId(dataTestId.messageComposer)).toBe(composer);
    expect(composer.value).toBe("Keep this draft unsent");
    expect(queryByRole(document.body, "dialog")).toBeNull();
});

test("Given an unavailable Chat, When automatic retries are exhausted and the user reconnects, Then the draft survives and repeated interruptions recover without replay", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock("2026-10-23T08:00:00Z");
    const app = await createTestApp({ connectAgent: true, interruptibleChat: true, clock });
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(composer instanceof HTMLTextAreaElement) || app.chatNetwork === null) {
        throw new Error("Expected an interruptible Chat");
    }
    await app.user.click(composer);
    await app.user.paste("Do not resend this draft");
    app.chatNetwork.disconnect();
    for (const attempt of [1, 2, 3]) {
        await app.waitForView(() =>
            expect(getByRole(document.body, "status", { name: "Chat connection" }).textContent).toContain(
                `Attempt ${attempt} of 3`,
            ),
        );
        await act(async () => clock.advanceBy(1000 * 2 ** (attempt - 1)));
    }
    await app.waitForView(() =>
        expect(getByRole(document.body, "status", { name: "Chat connection" }).textContent).toContain(
            "Could not reconnect to Chat",
        ),
    );
    await act(async () => clock.advanceBy(60_000));
    expect(getByRole(document.body, "status", { name: "Chat connection" }).textContent).toContain(
        "Could not reconnect to Chat",
    );
    expect(queryByRole(document.body, "dialog")).toBeNull();
    expect(composer.value).toBe("Do not resend this draft");
    app.chatNetwork.reconnect();
    await app.user.click(getByRole(document.body, "button", { name: "Reconnect" }));
    await app.waitForView(() => expect(queryByRole(document.body, "status", { name: "Chat connection" })).toBeNull());
    for (const _cycle of [1, 2]) {
        app.chatNetwork.disconnect();
        await app.waitForView(() =>
            expect(getByRole(document.body, "status", { name: "Chat connection" }).textContent).toContain(
                "Reconnecting to Chat",
            ),
        );
        app.chatNetwork.reconnect();
        await recoverChat(app, clock);
        await app.waitForView(() =>
            expect(queryByRole(document.body, "status", { name: "Chat connection" })).toBeNull(),
        );
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
    const app = await createTestApp({ connectAgent: true, interruptibleChat: true, clock });
    const initialComposer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(initialComposer instanceof HTMLTextAreaElement) || app.chatNetwork === null || app.daemon === null) {
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
    app.chatNetwork.disconnect();
    await app.waitForView(() => getByRole(document.body, "status", { name: "Chat connection" }));
    await app.daemon.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "text", text: "Finished during the Chat interruption" }],
    });
    app.chatNetwork.reconnect();
    await recoverChat(app, clock);
    await app.waitForView(() => {
        expect(queryByRole(document.body, "status", { name: "Chat connection" })).toBeNull();
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
