import { getByRole, queryAllByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

// The Worker checks the Runtime every 5 s and retries a failed check 5 s later, so one change can take two checks.
const RUNTIME_CHANGE_TIMEOUT_MS = 20_000;

function connectionStatus(app: TestApp): string | null {
    return app.elementByTestId(dataTestId.botConnectionStatus).getAttribute("data-connection-status");
}

function directoryTitles(app: TestApp): string[] {
    return app.elementsByTestId(dataTestId.managedConversation).map((entry) => entry.textContent ?? "");
}

function sidebarAlerts(): (string | null)[] {
    const sidebar = getByRole(document.body, "complementary", { name: "Morty navigation" });
    return queryAllByRole(sidebar, "alert").map((alert) => alert.textContent);
}

/** The accessible label of the status a directory entry shows, or null when it shows none. */
function entryStatus(app: TestApp, title: string): string | null {
    const entry = app
        .elementsByTestId(dataTestId.managedConversation)
        .find((candidate) => candidate.textContent?.includes(title));
    return entry?.querySelector(`[data-testid="${dataTestId.sessionStatus}"]`)?.getAttribute("aria-label") ?? null;
}

async function readyComposer(app: TestApp): Promise<HTMLElement> {
    return await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
}

function agentAnswered(app: TestApp, text: string): boolean {
    return app.elementsByTestId(dataTestId.agentResponse).some((message) => message.textContent?.includes(text));
}

test("Given a saved conversation, When opening it fails because its Runtime is offline and the Runtime comes back, Then the conversation opens without a reload", {
    timeout: 90_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    const draft = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    await sendPrompt(app, draft, "Keep this conversation");
    await app.waitForView(() => expect(agentAnswered(app, "Codex turn 1: Keep this conversation")).toBe(true));

    await daemon.disconnect();
    const reopened = await app.reload();
    // The conversation cannot open while the Runtime is offline: the page reports the failure and offers to retry.
    await reopened.waitForView(() => {
        expect(connectionStatus(reopened)).toBe("disconnected");
        expect(queryByRole(document.body, "button", { name: "Reconnect" })).not.toBeNull();
    }, RUNTIME_CHANGE_TIMEOUT_MS);

    await daemon.reconnect();
    await reopened.waitForView(() => {
        expect(connectionStatus(reopened)).toBe("connected");
        expect(agentAnswered(reopened, "Codex turn 1: Keep this conversation")).toBe(true);
        const composer = reopened.elementByTestId(dataTestId.messageComposer);
        expect(composer instanceof HTMLTextAreaElement && !composer.disabled).toBe(true);
    }, RUNTIME_CHANGE_TIMEOUT_MS);
});

test("Given a saved conversation, When a new-session page opens while the Runtime is offline and the Runtime comes back, Then the sidebar lists the conversation without a refresh", {
    timeout: 90_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await sendPrompt(app, await readyComposer(app), "Keep this conversation");
    await app.waitForView(() => expect(agentAnswered(app, "Codex turn 1: Keep this conversation")).toBe(true));
    await app.user.click(app.elementByTestId(dataTestId.newConversation));
    await app.waitForView(() => expect(directoryTitles(app)).toHaveLength(1));

    await daemon.disconnect();
    const reopened = await app.reload();
    // The sessions are read through the Runtime, so the sidebar cannot list them while it is offline.
    await reopened.waitForView(() => {
        expect(connectionStatus(reopened)).toBe("disconnected");
        expect(sidebarAlerts()).toEqual([expect.stringContaining("Your Mobius is disconnected.")]);
        expect(directoryTitles(reopened)).toHaveLength(0);
    }, RUNTIME_CHANGE_TIMEOUT_MS);

    await daemon.reconnect();
    await reopened.waitForView(() => {
        expect(connectionStatus(reopened)).toBe("connected");
        expect(directoryTitles(reopened).some((title) => title.includes("Keep this conversation"))).toBe(true);
        expect(sidebarAlerts()).toEqual([]);
    }, RUNTIME_CHANGE_TIMEOUT_MS);
});

test("Given a page following its sessions' statuses, When the Runtime goes offline and comes back, Then a reply in another session is marked unread again", {
    timeout: 90_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await sendPrompt(app, await readyComposer(app), "Background conversation");
    await app.waitForView(() => expect(agentAnswered(app, "Codex turn 1: Background conversation")).toBe(true));
    await app.user.click(app.elementByTestId(dataTestId.newConversation));
    await app.waitForView(() => expect(directoryTitles(app)).toHaveLength(1));

    await daemon.disconnect();
    // The Platform tells the status stream at once that the Runtime went offline, while the page learns it from its
    // next Runtime check. By the time the page shows it, the stream has ended and could not read the sessions again.
    await app.waitForView(() => expect(connectionStatus(app)).toBe("disconnected"), RUNTIME_CHANGE_TIMEOUT_MS);

    await daemon.reconnect();
    await app.waitForView(() => expect(connectionStatus(app)).toBe("connected"), RUNTIME_CHANGE_TIMEOUT_MS);
    // Another page answers in the background session while this page stays on its new session.
    const viewer = await app.openViewer();
    await viewer.user.click(
        await viewer.queryElementByTestId(dataTestId.managedConversation, (entry) =>
            Boolean(entry.textContent?.includes("Background conversation")),
        ),
    );
    await sendPrompt(viewer, await readyComposer(viewer), "Answer in the background");
    await viewer.waitForView(() => expect(agentAnswered(viewer, "Answer in the background")).toBe(true));

    await app.waitForView(
        () => expect(entryStatus(app, "Background conversation")).toBe("Unread response"),
        RUNTIME_CHANGE_TIMEOUT_MS,
    );
});
