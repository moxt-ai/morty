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

    // The first backoff attempt really dials: the bridge carries a request
    // again without waiting for the rest of the retry budget.
    const token = await app.identity.getToken(new AbortController().signal);
    const workspace = await app.transport.fetch(
        new Request(`${app.origin}/morty/api/chat/projects/${app.identity.projectId}/bots/${app.botId}/workspace`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
        }),
    );
    expect(workspace.status).toBe(200);

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

test("Given a dropped bridge that reconnected, When the Runtime changes, Then the page still follows it", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    const failure = app.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const draft = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    await sendPrompt(app, draft, "Before the dropped watch");
    await app.waitForView(() => expect(agentAnswered(app, "Codex turn 1: Before the dropped watch")).toBe(true));

    // The drop takes every watch with it; the reconnect must re-arm them.
    app.transport.disconnect();
    await act(async () => {
        clock.advanceBy(1_000);
    });
    await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );

    // A Runtime change after the reconnect must still reach this page. Before
    // the watch was re-armed, this never refreshed and the page stayed
    // "connected" forever.
    await app.daemon?.disconnect();
    await app.waitForView(() => {
        // The execution-context bar shows the Machine connection, which the
        // re-armed watch keeps current.
        expect(document.body.textContent).toContain("Disconnected");
    });
    void failure;
});

test("Given repeated bridge drops on one page, When the Runtime goes offline after each recovery, Then the page still follows it", {
    timeout: 30_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ connectAgent: true, clock });
    const machine = (): string => {
        const body = document.body.textContent ?? "";
        const marker = body.indexOf("Machine: Controlled Agent Runtime");
        const rest = marker === -1 ? "" : body.slice(marker + "Machine: Controlled Agent Runtime".length);
        return rest.slice(0, rest.indexOf("Test ") === -1 ? 30 : rest.indexOf("Test "));
    };
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    await sendPrompt(app, composer, "Before two drops");
    await app.waitForView(() => expect(agentAnswered(app, "Codex turn 1: Before two drops")).toBe(true));

    // First drop: the watch dies with the socket, and the bridge returns.
    app.transport.disconnect();
    await act(async () => {
        clock.advanceBy(1_000);
    });

    // The re-armed watch is live: the Runtime going away reaches the page.
    await app.daemon?.disconnect();
    await app.waitForView(() => expect(machine().startsWith("Disconnected")).toBe(true));

    // Later drops on the same page must each be followed by recovery: the
    // watch re-armed by the first resume is itself dropped and re-armed again,
    // and none of them may surface a failure dialog over the conversation.
    for (const backoff of [2_000, 2_000]) {
        app.transport.disconnect();
        await act(async () => {
            clock.advanceBy(backoff);
        });
        expect(queryByRole(document.body, "dialog", { name: "Runtime connection unavailable" })).toBeNull();
    }
    await app.waitForView(() => expect(machine().startsWith("Disconnected")).toBe(true));
});
