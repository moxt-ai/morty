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

test("Given a saved conversation, When reloading it while its Runtime is offline, Then its title and saved-history notice remain and reconnect restores history and the unsent draft", {
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

    const composer = await readyComposer(app);
    await app.user.click(composer);
    await app.user.paste("Keep this follow-up unsent");
    await app.user.click(getByRole(document.body, "button", { name: "Keep this conversation" }));
    const titleInput = getByRole(document.body, "textbox", { name: "Conversation title" });
    await app.user.clear(titleInput);
    await app.user.type(titleInput, "Saved offline conversation");
    await app.user.click(getByRole(document.body, "button", { name: "Save title" }));
    await app.waitForView(() =>
        expect(queryByRole(document.body, "heading", { name: "Saved offline conversation" })).not.toBeNull(),
    );

    await daemon.disconnect();
    const reopened = await app.reload();
    // A failed read must not present an existing conversation as a new, empty one.
    await reopened.waitForView(() => {
        expect(connectionStatus(reopened)).toBe("disconnected");
        expect(queryByRole(document.body, "button", { name: "Reconnect" })).not.toBeNull();
        expect(queryByRole(document.body, "heading", { name: "Saved offline conversation" })).not.toBeNull();
        expect(queryByRole(document.body, "heading", { name: "New session" })).toBeNull();
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Your conversation is saved on your computer. History will load when it reconnects.",
        );
        expect(document.body.textContent).not.toContain("Your Mobius is disconnected.");
    }, RUNTIME_CHANGE_TIMEOUT_MS);

    await daemon.reconnect();
    await reopened.waitForView(() => {
        expect(connectionStatus(reopened)).toBe("connected");
        expect(agentAnswered(reopened, "Codex turn 1: Keep this conversation")).toBe(true);
        const composer = reopened.elementByTestId(dataTestId.messageComposer);
        expect(composer instanceof HTMLTextAreaElement && !composer.disabled).toBe(true);
        expect(composer).toHaveProperty("value", "Keep this follow-up unsent");
        expect(
            reopened
                .elementsByTestId(dataTestId.agentResponse)
                .filter((message) => message.textContent?.includes("Codex turn 1: Keep this conversation")),
        ).toHaveLength(1);
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain(
            "Keep this follow-up unsent",
        );
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
        expect(sidebarAlerts()).toEqual([]);
        expect(document.body.textContent).toContain(
            "Your sessions are saved on your computer and will appear when it reconnects.",
        );
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

test("Given a background reply is running when the Runtime goes offline, When the Runtime comes back, Then the sidebar shows that reply no longer working", {
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
    // Another page starts a reply in the background conversation that is still running when the Runtime goes away.
    const viewer = await app.openViewer();
    await viewer.user.click(
        await viewer.queryElementByTestId(dataTestId.managedConversation, (entry) =>
            Boolean(entry.textContent?.includes("Background conversation")),
        ),
    );
    await sendPrompt(viewer, await readyComposer(viewer), "hold after first delta");
    await app.waitForView(() => expect(entryStatus(app, "Background conversation")).toBe("Session working"));
    await viewer.close();

    await daemon.disconnect();
    await app.waitForView(() => expect(connectionStatus(app)).toBe("disconnected"), RUNTIME_CHANGE_TIMEOUT_MS);
    await daemon.reconnect();
    await app.waitForView(() => expect(connectionStatus(app)).toBe("connected"), RUNTIME_CHANGE_TIMEOUT_MS);

    await app.waitForView(
        () => expect(entryStatus(app, "Background conversation")).not.toBe("Session working"),
        RUNTIME_CHANGE_TIMEOUT_MS,
    );
});

for (const context of ["missing", "malformed", "different-session", "different-identity"] as const) {
    test(`Given ${context} remembered context, When an existing conversation reloads offline, Then it uses an honest fallback without leaking a different title`, {
        timeout: 45_000,
    }, async () => {
        const app = await createTestApp({ connectAgent: true });
        const daemon = app.daemon;
        if (daemon === null) {
            throw new Error("Expected a connected Runtime");
        }
        await sendPrompt(app, await readyComposer(app), "Private saved conversation");
        await app.waitForView(() => expect(agentAnswered(app, "Codex turn 1: Private saved conversation")).toBe(true));
        // Browser persistence is an external input. Exercise invalid/absent data through a real page reload.
        const keys = Object.keys(window.sessionStorage).filter((key) => key.startsWith("morty:remembered-session:v1:"));
        for (const key of keys) {
            const saved = window.sessionStorage.getItem(key);
            window.sessionStorage.removeItem(key);
            if (context === "malformed") {
                window.sessionStorage.setItem(key, "{invalid json");
            } else if (context === "different-session") {
                window.sessionStorage.setItem(
                    key,
                    JSON.stringify({ id: "another-session", title: "Unrelated private title" }),
                );
            } else if (context === "different-identity" && saved !== null) {
                window.sessionStorage.setItem(`${key}-another-identity`, saved);
            }
        }
        await daemon.disconnect();
        const reopened = await app.reload();
        await reopened.waitForView(() => {
            expect(connectionStatus(reopened)).toBe("disconnected");
            expect(queryByRole(document.body, "heading", { name: "Existing session" })).not.toBeNull();
            expect(queryByRole(document.body, "heading", { name: "New session" })).toBeNull();
            expect(document.body.textContent).not.toContain("Private saved conversation");
            expect(document.body.textContent).not.toContain("Unrelated private title");
            expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
                "History is temporarily unavailable. It will load when the connection returns.",
            );
        }, RUNTIME_CHANGE_TIMEOUT_MS);
        await daemon.reconnect();
        await reopened.waitForView(
            () => expect(agentAnswered(reopened, "Codex turn 1: Private saved conversation")).toBe(true),
            RUNTIME_CHANGE_TIMEOUT_MS,
        );
    });
}

test("Given a remembered title for a session that no longer exists, When the server rejects its lookup, Then stale context is discarded and the failure is not described as offline", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await sendPrompt(app, await readyComposer(app), "A saved conversation");
    await app.waitForView(() => expect(agentAnswered(app, "Codex turn 1: A saved conversation")).toBe(true));
    const unavailableId = "chat_missing_session";
    for (const key of Object.keys(window.sessionStorage).filter((key) =>
        key.startsWith("morty:remembered-session:v1:"),
    )) {
        window.sessionStorage.setItem(key, JSON.stringify({ id: unavailableId, title: "Stale unavailable title" }));
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("conversationId");
    url.searchParams.set("sessionId", unavailableId);
    window.history.replaceState(null, "", url);
    const reopened = await app.reload();
    await reopened.waitForView(() => {
        expect(queryByRole(document.body, "button", { name: "Reconnect" })).toBeNull();
        expect(
            getByRole(getByRole(document.body, "log", { name: "Messages" }), "button", { name: "New Session" }),
        ).toBeDefined();
        expect(queryByRole(document.body, "heading", { name: "Existing session" })).not.toBeNull();
        expect(queryByRole(document.body, "heading", { name: "New session" })).toBeNull();
        expect(document.body.textContent).not.toContain("Stale unavailable title");
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("will load when");
    });
});
