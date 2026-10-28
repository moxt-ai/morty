import { getByLabelText, getByRole, queryAllByRole, queryAllByText, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment } from "./support/chat-worker.ts";

const recoveredFailure = "The local Agent could not complete the request";

for (const submission of ["rejected", "upload-failed"] as const) {
    test(`Given a failed turn followed by a ${submission} message, When the Runtime silently reconnects, Then the latest submission result survives without reviving the old failure`, {
        timeout: 60_000,
    }, async () => {
        const app = await createTestApp({ connectAgent: true, clock: new TestClock("2026-10-28T08:00:00Z") });
        const daemon = app.daemon;
        if (daemon === null) {
            throw new Error("Expected the connected Runtime");
        }
        await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
        await app.waitForView(() => {
            expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Established session");
            expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        });
        const composer = await app.queryElementByTestId(dataTestId.messageComposer);
        const form = composer.closest("form");
        if (form === null) {
            throw new Error("Expected the composer form");
        }
        await sendPrompt(app, composer, "fail this turn explicitly");
        await app.waitForView(() => expect(entryStatus(app, "Established session")).toBe("Session failed"));
        if (submission === "upload-failed") {
            await app.user.upload(
                getByLabelText(document.body, "Choose attachments"),
                new File(["Unsent attachment"], `${"notes".repeat(101)}.json`, { type: "text/plain" }),
            );
            await app.waitForView(() => getByRole(form, "list", { name: "Attachments" }));
        }
        // Both requests are rejected by real production validation before a new Agent turn starts.
        const prompt = submission === "rejected" ? "x".repeat(100_001) : "Keep this unsent message";
        await sendPrompt(app, composer, prompt);
        const submissionError = await app.waitForView(() => {
            expect(composer).toHaveProperty("disabled", false);
            expect(composer).toHaveProperty("value", prompt);
            const message = getByRole(form, "alert").textContent;
            expect(message).toBeTruthy();
            expect(message).not.toContain(recoveredFailure);
            return message;
        });
        const status = submission === "rejected" ? null : "Session failed";
        expect(entryStatus(app, "Established session")).toBe(status);

        await daemon.disconnect();
        await app.waitForView(() =>
            getByRole(document.body, "button", { name: /Switch computer/, description: "Reconnecting" }),
        );
        expect(app.optionalElementByTestId(dataTestId.sessionReconnectNotice)).toBeNull();
        await daemon.reconnect();
        document.dispatchEvent(new Event("visibilitychange"));
        await app.waitForView(() =>
            expect(getByRole(form, "button", { name: "Send message" })).toHaveProperty("disabled", false),
        );
        expect(app.optionalElementByTestId(dataTestId.sessionReconnectNotice)).toBeNull();
        expect(entryStatus(app, "Established session")).toBe(status);
        expect(getByRole(form, "alert").textContent).toBe(submissionError);
        expect(queryAllByText(document.body, recoveredFailure, { exact: true })).toHaveLength(0);
        expect(composer).toHaveProperty("value", prompt);
    });
}

test("Given a rejected submission after an earlier failure, When another viewer's new turn fails while I am disconnected, Then reconnect recovers the new failure", {
    timeout: 60_000,
}, async () => {
    const clock = new TestClock("2026-10-28T08:00:00Z");
    const app = await createTestApp({ connectAgent: true, clock });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Established session");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    const form = composer.closest("form");
    if (form === null) {
        throw new Error("Expected the composer form");
    }
    await sendPrompt(app, composer, "fail this turn explicitly");
    await app.waitForView(() => expect(entryStatus(app, "Established session")).toBe("Session failed"));
    await sendPrompt(app, composer, "x".repeat(100_001));
    await app.waitForView(() => {
        expect(entryStatus(app, "Established session")).toBeNull();
        expect(getByRole(form, "alert").textContent).toBeTruthy();
    });
    const other = await app.openViewer();
    const otherComposer = await other.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    app.transport.disconnect();
    await app.waitForView(() =>
        expect(getByRole(form, "button", { name: "Send message" })).toHaveProperty("disabled", true),
    );
    await other.user.clear(otherComposer);
    await sendPrompt(other, otherComposer, "fail this turn explicitly");
    await other.waitForView(() => {
        expect(other.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        expect(entryStatus(other, "Established session")).toBe("Session failed");
    });
    expect(getByRole(form, "button", { name: "Send message" })).toHaveProperty("disabled", true);
    expect(entryStatus(app, "Established session")).toBeNull();
    await act(async () => clock.advanceBy(1_000));
    await app.waitForView(() => {
        expect(getByRole(form, "button", { name: "Send message" })).toHaveProperty("disabled", false);
        expect(getByRole(form, "alert").textContent).toBe("Internal error: The controlled Agent rejected this turn.");
        expect(entryStatus(app, "Established session")).toBe("Session failed");
    });
});

function sessionEntry(app: TestApp, title: string): HTMLElement {
    const entry = app
        .elementsByTestId(dataTestId.managedConversation)
        .find((element) => element.textContent?.includes(title));
    if (entry === undefined) {
        throw new Error(`Expected the ${title} Session in the sidebar`);
    }
    return entry;
}

function entryStatus(app: TestApp, title: string): string | null {
    return (
        sessionEntry(app, title)
            .querySelector(`[data-testid="${dataTestId.sessionStatus}"]`)
            ?.getAttribute("aria-label") ?? null
    );
}

test("Given a turn that fails while I am in another Session, When I return, Then I see its failure, the sidebar agrees, and my next message clears it", {
    timeout: 60_000,
}, async () => {
    const environment = await createChatWorkerEnvironment(true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const network = app.network;
    if (network === null) {
        throw new Error("Expected the controllable network");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Established session");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    network.holdNextTurn();
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "fail this turn explicitly");
    await app.waitForView(() => expect(network.submissions.at(-1)).toContain("fail this turn explicitly"));

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    network.releaseHeldTurn();
    // The turn ran and ended while another Session was selected.
    await app.waitForView(() => expect(entryStatus(app, "Established session")).toBe("Unread response"));

    await app.user.click(sessionEntry(app, "Established session"));
    const composer = await app.waitForView(() => {
        expect(queryAllByText(document.body, recoveredFailure, { exact: true })).toHaveLength(1);
        expect(entryStatus(app, "Established session")).toBe("Session failed");
        expect(queryByRole(document.body, "button", { name: "Retry message with unknown delivery" })).toBeNull();
        const element = app.elementByTestId(dataTestId.messageComposer);
        if (!(element instanceof HTMLTextAreaElement) || element.disabled) {
            throw new Error("Expected an enabled message composer");
        }
        return element;
    });
    expect(
        app
            .elementsByTestId(dataTestId.userMessage)
            .filter((element) => element.textContent?.includes("fail this turn explicitly")),
    ).toHaveLength(1);

    await sendPrompt(app, composer, "Keep chatting");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Keep chatting");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        expect(queryAllByText(document.body, recoveredFailure, { exact: true })).toHaveLength(0);
        expect(entryStatus(app, "Established session")).toBeNull();
    });
});

test("Given my last turn completed while I was away after an earlier failure, When I return, Then no stale failure is shown", {
    timeout: 60_000,
}, async () => {
    const environment = await createChatWorkerEnvironment(true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const network = app.network;
    if (network === null) {
        throw new Error("Expected the controllable network");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull());
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "fail this turn explicitly");
    await app.waitForView(() => expect(entryStatus(app, "Established session")).toBe("Session failed"));
    network.holdNextTurn();
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Finish while away");
    await app.waitForView(() => expect(network.submissions.at(-1)).toContain("Finish while away"));

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    network.releaseHeldTurn();
    await app.waitForView(() => expect(entryStatus(app, "Established session")).toBe("Unread response"));

    await app.user.click(sessionEntry(app, "Established session"));
    await app.waitForView(() => {
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain("Finish while away");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        expect(entryStatus(app, "Established session")).toBeNull();
        expect(queryAllByText(document.body, recoveredFailure, { exact: true })).toHaveLength(0);
        expect(queryAllByRole(document.body, "alert")).toHaveLength(0);
    });
});
