import { getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { refreshSessions, sendPrompt, showReconnectNotice } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment, dedicatedEnvironmentTimeout } from "./support/chat-worker.ts";

const CLOSED_ON_REQUEST = "This Session was closed on request.";
const HELD_PROMPT = "hold after first delta";

function closedNoticeText(app: TestApp): string | null {
    const notice = app.optionalElementByTestId(dataTestId.sessionClosedNotice);
    return notice === null ? null : notice.textContent;
}

function reconnectStatusText(app: TestApp): string | null {
    const notice = app.optionalElementByTestId(dataTestId.sessionReconnectNotice);
    return notice === null ? null : notice.textContent;
}

function sendButtonLabel(app: TestApp): string | null {
    return app.elementByTestId(dataTestId.sendMessage).getAttribute("aria-label");
}

function readyComposer(element: HTMLElement): boolean {
    return element instanceof HTMLTextAreaElement && !element.disabled;
}

async function openSavedConversation(app: TestApp): Promise<string> {
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    const draft = await app.queryElementByTestId(dataTestId.messageComposer, readyComposer);
    if (!(draft instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the draft composer");
    }
    await sendPrompt(app, draft, HELD_PROMPT);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((entry) => entry.textContent?.includes("Partial reply")),
        ).toBe(true),
    );
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (sessionId === null) {
        throw new Error("The opened conversation must have an address");
    }
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await daemon.continueReply(HELD_PROMPT, { outcome: "complete", output: [] });
    await refreshSessions(app);
    await app.queryElementByTestId(
        dataTestId.sessionStatus,
        (element) => element.getAttribute("aria-label") === "Unread response",
    );
    const conversation = app
        .elementsByTestId(dataTestId.managedConversation)
        .find((candidate) => candidate.textContent?.includes(HELD_PROMPT));
    if (conversation === undefined) {
        throw new Error("Expected the saved conversation");
    }
    await app.user.click(conversation);
    await app.queryElementByTestId(dataTestId.messageComposer, readyComposer);
    return sessionId;
}

test("Given an open conversation, When another client closes its Session and the browser resumes, Then Chat keeps it closed and offers to reopen it", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const sessionId = await openSavedConversation(app);
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }

    await daemon.closeSession(sessionId);

    await app.waitForView(() => expect(closedNoticeText(app)).toContain(CLOSED_ON_REQUEST));
    await act(async () => {
        window.dispatchEvent(new Event("online"));
        document.dispatchEvent(new Event("visibilitychange"));
        document.dispatchEvent(new Event("resume"));
    });
    const composer = app.elementByTestId(dataTestId.messageComposer);
    expect(composer instanceof HTMLTextAreaElement && composer.disabled).toBe(true);
    expect(
        getByRole(app.elementByTestId(dataTestId.sessionClosedNotice), "button", { name: "Reopen it" }),
    ).toBeDefined();
});

test("Given a closed Session, When the user reopens it, Then the notice goes away and the next message gets a reply", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const sessionId = await openSavedConversation(app);
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await daemon.closeSession(sessionId);
    const notice = await app.queryElementByTestId(dataTestId.sessionClosedNotice);

    await app.user.click(getByRole(notice, "button", { name: "Reopen it" }));

    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionClosedNotice)).toBeNull());
    const composer = await app.queryElementByTestId(dataTestId.messageComposer, readyComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the composer");
    }
    await sendPrompt(app, composer, "Continue the plan");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((entry) => entry.textContent?.includes("Continue the plan")),
        ).toBe(true),
    );
});

test("Given a closed Session and an offline Runtime, When the user tries to reopen it, Then Chat explains why it failed and the user can try again", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const sessionId = await openSavedConversation(app);
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await daemon.closeSession(sessionId);
    const notice = await app.queryElementByTestId(dataTestId.sessionClosedNotice);
    const form = notice.closest("form");
    if (form === null) {
        throw new Error("Expected the composer form");
    }
    await daemon.disconnect();

    await app.user.click(getByRole(notice, "button", { name: "Reopen it" }));

    await app.waitForView(() => expect(queryByRole(form, "alert")?.textContent).toContain("disconnected"));
    expect(closedNoticeText(app)).toContain("Reopen it");

    await daemon.reconnect();
    await app.user.click(
        getByRole(app.elementByTestId(dataTestId.sessionClosedNotice), "button", { name: "Reopen it" }),
    );

    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionClosedNotice)).toBeNull());
    expect(queryByRole(form, "alert")).toBeNull();
});

test("Given a conversation whose Runtime restarted and then closed its Session while Chat was waiting to reconnect, When Chat reconnects, Then it shows that the session is closed and the user can reopen it", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock("2026-10-13T08:00:00Z");
    const app = await createTestApp({ connectAgent: true, clock });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    const composer = await app.queryElementByTestId(dataTestId.messageComposer, readyComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the draft composer");
    }
    await sendPrompt(app, composer, "Plan the release");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((entry) => entry.textContent?.includes("Plan the release")),
        ).toBe(true),
    );
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (sessionId === null) {
        throw new Error("The opened conversation must have an address");
    }
    await daemon.disconnect();
    await showReconnectNotice(app, clock);
    await app.waitForView(() => expect(reconnectStatusText(app)).toContain("Retrying in"));
    await daemon.reconnect();
    await daemon.closeSession(sessionId);

    await act(async () => clock.advanceBy(10_000));

    // Chat may or may not hear the Runtime announce the closing, so the reason is not part of this scenario.
    await app.waitForView(() => expect(closedNoticeText(app)).toMatch(/^The session is closed\./));
    expect(reconnectStatusText(app)).toBeNull();
    await app.user.click(
        getByRole(app.elementByTestId(dataTestId.sessionClosedNotice), "button", { name: "Reopen it" }),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionClosedNotice)).toBeNull());
    const reopened = await app.queryElementByTestId(dataTestId.messageComposer, readyComposer);
    if (!(reopened instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the composer");
    }
    await sendPrompt(app, reopened, "Ship it");
    await app.waitForView(() =>
        expect(
            app.elementsByTestId(dataTestId.agentResponse).some((entry) => entry.textContent?.includes("Ship it")),
        ).toBe(true),
    );
});

test("Given a reply that is still running, When its turn outcome precedes a delayed close notice, Then it closes and reopens without a failed reply", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ connectAgent: true, environment });
    const sessionId = await openSavedConversation(app);
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    const composer = await app.queryElementByTestId(dataTestId.messageComposer, readyComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the composer");
    }
    await sendPrompt(app, composer, HELD_PROMPT);
    await app.waitForView(() => expect(sendButtonLabel(app)).toBe("Stop agent output"));

    const network = app.executionNetwork;
    if (network === null) {
        throw new Error("Expected the real transport proxy");
    }
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .filter((entry) => entry.textContent?.includes("Partial reply")),
        ).toHaveLength(2),
    );
    // Keep each connection in order while delivering the turn outcome before the separate close notice.
    const notice = network.holdNextCloseNotice();
    await daemon.closeSession(sessionId);
    const releaseNotice = await notice;
    try {
        await app.waitForView(() => expect(sendButtonLabel(app)).toBe("Send message"));
        expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
    } finally {
        releaseNotice();
    }

    await app.waitForView(() => expect(closedNoticeText(app)).toContain(CLOSED_ON_REQUEST));
    await app.waitForView(() => expect(sendButtonLabel(app)).toBe("Send message"));
    expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
    expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    await app.user.click(
        getByRole(app.elementByTestId(dataTestId.sessionClosedNotice), "button", { name: "Reopen it" }),
    );
    await app.queryElementByTestId(dataTestId.messageComposer, readyComposer);
    expect(closedNoticeText(app)).toBeNull();
    expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
});
