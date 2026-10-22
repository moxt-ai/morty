import { getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

function reconnectStatusText(app: TestApp): string | null {
    const notice = app.optionalElementByTestId(dataTestId.sessionReconnectNotice);
    if (notice === null) {
        return null;
    }
    return queryByRole(notice, "status")?.textContent ?? null;
}

const CLOCK_ORIGIN = "2026-10-13T08:00:00Z";

test("Given an offline Runtime, When the retry deadline elapses, Then the countdown advances and automatic retries back off", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    await openSavedConversation(app, "Survive a Runtime restart");
    if (app.daemon === null) {
        throw new Error("Expected the connected Runtime");
    }
    await app.daemon.disconnect();
    await app.waitForView(() => expect(reconnectStatusText(app)).toBe("Retrying in 5 s Retry now"));
    const notice = app.elementByTestId(dataTestId.sessionReconnectNotice);
    const form = notice.closest("form");
    if (form === null) {
        throw new Error("Expected the composer form");
    }
    expect(queryByRole(form, "alert")?.textContent).toContain("could not recover");
    await act(async () => clock.advanceBy(1000));
    expect(reconnectStatusText(app)).toBe("Retrying in 4 s Retry now");
    await act(async () => clock.advanceBy(3999));
    expect(reconnectStatusText(app)).toBe("Retrying in 1 s Retry now");
    await act(async () => clock.advanceBy(1));
    await app.waitForView(() => expect(reconnectStatusText(app)).toBe("Retrying in 10 s Retry now"));
    // The Relay now refuses the retry itself while the Runtime is offline, instead of the stream failing to recover.
    expect(queryByRole(form, "alert")?.textContent).toContain("The Runtime is offline");
    await act(async () => clock.advanceBy(10000));
    await app.waitForView(() => expect(reconnectStatusText(app)).toBe("Retrying in 20 s Retry now"));
});

async function openSavedConversation(app: TestApp, prompt: string): Promise<HTMLTextAreaElement> {
    const draft = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(draft instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the draft composer");
    }
    await sendPrompt(app, draft, prompt);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((message) => message.textContent?.includes(`Codex turn 1: ${prompt}`)),
        ).toBe(true),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const saved = await app.waitForView(() => {
        const conversation = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((candidate) => candidate.textContent?.includes(prompt));
        if (conversation === undefined) {
            throw new Error("Waiting for the saved conversation");
        }
        return conversation;
    });
    await app.user.click(saved);
    await app.waitForView(() =>
        expect(queryByRole(document.body, "heading", { level: 2, name: prompt })).not.toBeNull(),
    );
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the saved conversation composer");
    }
    return composer;
}

test("Given a disconnected conversation with an unsent draft, When the same Runtime reconnects twice, Then its connection error clears without sending and the draft remains", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    const composer = await openSavedConversation(app, "Before the Runtime restart");
    if (app.daemon === null) {
        throw new Error("Expected a connected Runtime");
    }
    await app.user.click(composer);
    await app.user.paste("Keep this unsent draft");
    const form = composer.closest("form");
    if (form === null) {
        throw new Error("Expected the composer form");
    }
    for (const cycle of [1, 2]) {
        await app.daemon.disconnect();
        await app.waitForView(() =>
            expect(reconnectStatusText(app), `disconnect ${cycle}`).toBe("Retrying in 5 s Retry now"),
        );
        expect(queryByRole(form, "alert")?.textContent).toContain("could not recover");
        expect(composer.disabled).toBe(true);
        await app.daemon.reconnect();
        const retry = queryByRole(form, "button", { name: "Retry now" });
        if (!(retry instanceof HTMLButtonElement)) {
            throw new Error("Expected manual reconnect control");
        }
        await app.user.click(retry);
        await app.waitForView(() => {
            expect(composer.disabled, `recovery ${cycle}`).toBe(false);
            expect(reconnectStatusText(app)).toBeNull();
        });
        expect(queryByRole(form, "alert")).toBeNull();
        expect(composer.value).toBe("Keep this unsent draft");
    }
    await app.user.clear(composer);
    await sendPrompt(app, composer, "After the Runtime restart");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((message) => message.textContent?.includes("Codex turn 2: After the Runtime restart")),
        ).toBe(true),
    );
});

test("Given a failed Agent turn, When its Runtime disconnects and reconnects, Then the unrelated turn error remains visible", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    const composer = await openSavedConversation(app, "Before the failed turn");
    if (app.daemon === null) {
        throw new Error("Expected a connected Runtime");
    }
    const form = composer.closest("form");
    if (form === null) {
        throw new Error("Expected the composer form");
    }
    await sendPrompt(app, composer, "fail this turn explicitly");
    await app.waitForView(() =>
        expect(queryByRole(form, "alert")?.textContent, document.body.textContent ?? "").toContain(
            "The controlled Agent rejected this turn.",
        ),
    );
    await app.daemon.disconnect();
    await app.waitForView(() => expect(reconnectStatusText(app)).toContain("Retrying in"));
    await app.daemon.reconnect();
    const retry = queryByRole(form, "button", { name: "Retry now" });
    if (!(retry instanceof HTMLButtonElement)) {
        throw new Error("Expected manual reconnect control");
    }
    await app.user.click(retry);
    await app.waitForView(() => {
        expect(composer.disabled).toBe(false);
        expect(reconnectStatusText(app)).toBeNull();
    });
    expect(queryByRole(form, "alert")?.textContent).toContain("The controlled Agent rejected this turn.");
});

test("Given a recovered Runtime and an unsent draft, When the retry deadline arrives, Then Chat recovers automatically without sending the draft", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    const composer = await openSavedConversation(app, "Recover automatically");
    if (app.daemon === null) {
        throw new Error("Expected the connected Runtime");
    }
    await app.user.click(composer);
    await app.user.paste("Still unsent");
    await app.daemon.disconnect();
    await app.waitForView(() => expect(reconnectStatusText(app)).toBe("Retrying in 5 s Retry now"));
    await app.daemon.reconnect();
    await act(async () => clock.advanceBy(4999));
    expect(composer.disabled).toBe(true);
    expect(reconnectStatusText(app)).toBe("Retrying in 1 s Retry now");
    await act(async () => clock.advanceBy(1));
    await app.waitForView(() => expect(composer.disabled).toBe(false));
    expect(reconnectStatusText(app)).toBeNull();
    expect(queryByRole(composer.closest("form") ?? document.body, "alert")).toBeNull();
    expect(composer.value).toBe("Still unsent");
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("Still unsent");
    await act(async () => clock.advanceBy(60000));
    expect(composer.disabled).toBe(false);
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("Still unsent");
});
