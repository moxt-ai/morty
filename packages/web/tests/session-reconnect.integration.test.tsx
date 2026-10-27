import { getByLabelText, getByRole, queryAllByRole, queryAllByText, queryByRole } from "@testing-library/dom";
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
    return notice.textContent;
}

function retrySeconds(app: TestApp): number {
    const match = /Retrying in (\d+) s/u.exec(reconnectStatusText(app) ?? "");
    if (match === null) {
        throw new Error("Waiting for the visible retry countdown");
    }
    return Number(match[1]);
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
    const firstDelay = await app.waitForView(() => retrySeconds(app));
    expect(firstDelay).toBeGreaterThanOrEqual(3);
    expect(firstDelay).toBeLessThanOrEqual(5);
    const notice = app.elementByTestId(dataTestId.sessionReconnectNotice);
    const form = notice.closest("form");
    if (form === null) {
        throw new Error("Expected the composer form");
    }
    expect(queryByRole(form, "alert")).toBeNull();
    await act(async () => clock.advanceBy(1000));
    expect(retrySeconds(app)).toBe(firstDelay - 1);
    await act(async () => clock.advanceBy((firstDelay - 2) * 1000));
    expect(retrySeconds(app)).toBe(1);
    await act(async () => clock.advanceBy(1000));
    const secondDelay = await app.waitForView(() => retrySeconds(app));
    expect(secondDelay).toBeGreaterThanOrEqual(5);
    expect(secondDelay).toBeLessThanOrEqual(10);
    expect(queryByRole(form, "alert")).toBeNull();
    await act(async () => clock.advanceBy(secondDelay * 1000));
    const thirdDelay = await app.waitForView(() => retrySeconds(app));
    expect(thirdDelay).toBeGreaterThanOrEqual(10);
    expect(thirdDelay).toBeLessThanOrEqual(20);
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

test("Given a failed Agent turn, When its Runtime reconnects and the conversation reloads, Then the live failure is not duplicated or replayed into history", {
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
    const messages = getByRole(document.body, "log", { name: "Messages" });
    await app.waitForView(() => {
        expect(queryByRole(messages, "alert")?.textContent, document.body.textContent ?? "").toContain(
            "The controlled Agent rejected this turn.",
        );
        expect(queryByRole(form, "alert")).toBeNull();
    });
    await app.daemon.disconnect();
    await app.waitForView(() => expect(reconnectStatusText(app)).toContain("Retrying in"));
    expect(
        queryAllByText(document.body, "Internal error: The controlled Agent rejected this turn.", { exact: true }),
    ).toHaveLength(1);
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
    // Execution receipts remain available to the daemon, but lifecycle failures
    // are not replayed into projected conversation history.
    await app.waitForView(() => {
        expect(
            queryAllByText(document.body, "The local Agent could not complete the request", { exact: true }),
        ).toHaveLength(0);
        expect(
            queryAllByText(document.body, "Internal error: The controlled Agent rejected this turn.", { exact: true }),
        ).toHaveLength(1);
        expect(queryAllByRole(document.body, "alert")).toHaveLength(1);
    });
    const reloaded = await app.reload();
    await reloaded.queryElementByTestId(dataTestId.messageComposer);
    await reloaded.waitForView(() => {
        expect(
            queryAllByText(document.body, "Internal error: The controlled Agent rejected this turn.", { exact: true }),
        ).toHaveLength(0);
        expect(queryAllByRole(document.body, "alert")).toHaveLength(0);
    });
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
    const delay = await app.waitForView(() => retrySeconds(app));
    await app.daemon.reconnect();
    await act(async () => clock.advanceBy((delay - 1) * 1000));
    expect(composer.disabled).toBe(false);
    expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", true);
    expect(reconnectStatusText(app)).toContain("Retrying in 1 s");
    await act(async () => clock.advanceBy(1000));
    await app.waitForView(() => {
        expect(reconnectStatusText(app)).toBeNull();
        expect(composer.disabled).toBe(false);
    });
    expect(queryByRole(composer.closest("form") ?? document.body, "alert")).toBeNull();
    expect(composer.value).toBe("Still unsent");
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("Still unsent");
    await act(async () => clock.advanceBy(60000));
    expect(composer.disabled).toBe(false);
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("Still unsent");
});

test("Given an unavailable Runtime and an editable draft, When automatic retries are exhausted and the user reconnects, Then one actionable failure clears and the draft is never sent automatically", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    const composer = await openSavedConversation(app, "Recover after exhausted retries");
    if (app.daemon === null) {
        throw new Error("Expected a connected Runtime");
    }
    await app.user.type(composer, "Keep editing through failure");
    await app.daemon.disconnect();
    for (let attempt = 0; attempt < 7; attempt += 1) {
        const seconds = await app.waitForView(() => retrySeconds(app));
        await act(async () => clock.advanceBy(seconds * 1000));
    }
    await app.waitForView(() => expect(getByRole(document.body, "alert").textContent).toContain("Couldn’t reconnect"));
    expect(composer.disabled).toBe(false);
    expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", true);
    await app.user.type(composer, " even now");
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File(["Keep this unsent attachment"], "recovery-notes.json", { type: "text/plain" }),
    );
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("recovery-notes.json"),
    );
    expect(
        queryByRole(document.body, "button", { name: /Switch computer/, description: "Connection available" }),
    ).toBeNull();
    await app.daemon.reconnect();
    await app.user.click(getByRole(document.body, "button", { name: "Retry now" }));
    await app.waitForView(() => expect(reconnectStatusText(app)).toBeNull());
    expect(queryByRole(document.body, "alert")).toBeNull();
    expect(composer.value).toBe("Keep editing through failure even now");
    expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("recovery-notes.json");
    expect(getByRole(document.body, "button", { name: "Send message" })).toHaveProperty("disabled", false);
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain(
        "Keep editing through failure",
    );
});

test("Given an active turn and an unsent follow-up, When connection freshness is lost and Enter is pressed, Then the follow-up stays in the composer until recovery", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await app.waitForView(() => expect(reconnectStatusText(app)).toBeNull());
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    await app.user.type(composer, "Keep my follow-up");
    expect(composer).toHaveProperty("value", "Keep my follow-up");
    app.transport.disconnect();
    await app.waitForView(() => expect(app.elementByTestId(dataTestId.sendMessage)).toHaveProperty("disabled", true));
    await app.user.keyboard("{Enter}");
    expect(composer).toHaveProperty("value", "Keep my follow-up");
    expect(app.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull();
    await act(async () => clock.advanceBy(1_000));
    await app.waitForView(() => expect(reconnectStatusText(app)).toBeNull());
    expect(composer).toHaveProperty("value", "Keep my follow-up");
    await app.user.keyboard("{Enter}");
    await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes("Keep my follow-up") === true,
    );
});
