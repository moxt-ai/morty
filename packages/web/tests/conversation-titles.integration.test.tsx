import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment } from "./support/chat-worker.ts";

async function readyComposer(app: TestApp): Promise<HTMLTextAreaElement> {
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    return composer;
}

function directoryTitles(app: TestApp): readonly string[] {
    return app.elementsByTestId(dataTestId.managedConversation).map((entry) => entry.textContent ?? "");
}

test("Given an open session renamed by another client, When its directory refreshes, Then the header and title editor use the same current title", {
    timeout: 30_000,
}, async () => {
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const original = "One title across the workspace";
    const renamed = "Updated by another client";
    await sendPrompt(app, await readyComposer(app), original);
    await app.waitForView(() =>
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            `Codex turn 1: ${original}`,
        ),
    );
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (app.daemon === null || sessionId === null || app.executionNetwork === null) {
        throw new Error("Expected an open Session on the connected Runtime");
    }
    // The list read can arrive before a live title event. Keep the real event in transit until after the assertions.
    const releaseEvents = app.executionNetwork.holdSessionEvents();
    onTestFinished(releaseEvents);
    await app.daemon.renameSession(sessionId, renamed);
    await app.user.click(getByRole(document.body, "button", { name: "Refresh sessions" }));
    await app.waitForView(() => getByRole(document.body, "button", { name: `Open ${renamed}` }));
    await app.waitForView(() => getByRole(document.body, "heading", { name: renamed }));
    await app.user.click(getByRole(document.body, "button", { name: renamed }));
    expect(getByRole(document.body, "textbox", { name: "Conversation title" })).toHaveProperty("value", renamed);
});

test("Given a selected session renamed elsewhere, When the view reattaches and later reloads offline, Then the title learned by the re-read survives", {
    timeout: 60_000,
}, async () => {
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true, clock: new TestClock("2026-10-29T00:00:00Z") });
    const original = "Remember the selected session";
    const renamed = "Title learned on reattach";
    await sendPrompt(app, await readyComposer(app), original);
    await app.waitForView(() =>
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            `Codex turn 1: ${original}`,
        ),
    );
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (app.daemon === null || sessionId === null || app.executionNetwork === null) {
        throw new Error("Expected an open Session on the connected Runtime");
    }
    const releaseEvents = app.executionNetwork.holdSessionEvents();
    onTestFinished(releaseEvents);
    await app.daemon.renameSession(sessionId, renamed);
    app.remount();
    await app.waitForView(() => getByRole(document.body, "heading", { name: renamed }));
    await app.daemon.disconnect();
    const reopened = await app.reload();
    await reopened.waitForView(() => getByRole(document.body, "heading", { name: renamed }));
});

test("Given a conversation this page created, When another client renames it, Then the directory shows the new name once it reloads", {
    timeout: 30_000,
}, async () => {
    const firstPrompt = "Name this conversation from the first prompt";
    const renamed = "Renamed by another client";
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );

    await sendPrompt(app, await readyComposer(app), firstPrompt);
    await app.waitForView(() => {
        expect(queryByRole(document.body, "heading", { level: 2, name: firstPrompt })).not.toBeNull();
        expect(directoryTitles(app).some((title) => title.includes(firstPrompt))).toBe(true);
        // The first-prompt title is optimistic; wait for delivery before leaving
        // so this scenario renames a prompted Session, not an unsent draft.
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((response) => response.textContent?.includes(firstPrompt)),
        ).toBe(true);
    });
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (sessionId === null) {
        throw new Error("The opened conversation must have an address");
    }

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await daemon.renameSession(sessionId, renamed);
    // Starting another conversation reloads the directory.
    await sendPrompt(app, await readyComposer(app), "Start another conversation");

    await app.waitForView(() => {
        const titles = directoryTitles(app);
        expect(titles.some((title) => title.includes("Start another conversation"))).toBe(true);
        expect(titles.some((title) => title.includes(renamed))).toBe(true);
        expect(titles.some((title) => title.includes(firstPrompt))).toBe(false);
    });
});

test("Given a saved title differs from the native session listing, When reopening Chat and selecting it in Open Session, Then the listing and preview use the recent session title", {
    timeout: 30_000,
}, async () => {
    const title = "Agent generated title";
    const app = await createTestApp({ connectAgent: true, nativeSessionIds: new Set(["title-review"]) });
    await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: "Open Session" })));
    const initialDialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    // The first native session is selected and previewed automatically.
    await app.waitForView(() =>
        expect(getByRole(initialDialog, "button", { name: "Native title-review" }).getAttribute("aria-pressed")).toBe(
            "true",
        ),
    );
    await app.waitForView(() => getByRole(initialDialog, "heading", { name: "Native title-review" }));
    await app.user.click(getByRole(initialDialog, "button", { name: "Open" }));
    await app.waitForView(() => expect(queryByRole(document.body, "dialog", { name: "Open Session" })).toBeNull());
    await app.waitForView(() => getByRole(document.body, "heading", { name: "Native title-review" }));
    await sendPrompt(app, await readyComposer(app), "Use the Agent generated title");
    await app.waitForView(() => {
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "The Agent generated a concise title.",
        );
        expect(getByRole(document.body, "heading", { name: title })).toBeDefined();
    });

    const reopened = await app.reload();
    await reopened.waitForView(() => expect(directoryTitles(reopened).some((item) => item.includes(title))).toBe(true));
    await reopened.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const dialog = await reopened.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    await reopened.waitForView(() =>
        expect(getByRole(dialog, "button", { name: title }).getAttribute("aria-pressed")).toBe("true"),
    );
    const preview = getByRole(dialog, "region", { name: "Selected session preview" });
    await reopened.waitForView(() => getByRole(preview, "heading", { name: title }));

    await reopened.user.click(getByRole(dialog, "button", { name: "Close dialog" }));
    await reopened.waitForView(() => expect(queryByRole(document.body, "dialog", { name: "Open Session" })).toBeNull());
    await reopened.user.click(await reopened.waitForView(() => getByRole(document.body, "button", { name: title })));
    const input = getByRole(document.body, "textbox", { name: "Conversation title" });
    await reopened.user.clear(input);
    await reopened.user.type(input, "My renamed session");
    await reopened.user.click(getByRole(document.body, "button", { name: "Save title" }));
    await reopened.waitForView(() => getByRole(document.body, "heading", { name: "My renamed session" }));
    await reopened.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const renamedDialog = await reopened.waitForView(() =>
        getByRole(document.body, "dialog", { name: "Open Session" }),
    );
    await reopened.waitForView(() =>
        expect(getByRole(renamedDialog, "button", { name: "My renamed session" }).getAttribute("aria-pressed")).toBe(
            "true",
        ),
    );
    await reopened.waitForView(() => getByRole(renamedDialog, "heading", { name: "My renamed session" }));
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (app.daemon === null || sessionId === null) {
        throw new Error("Expected an open Session on the connected Runtime");
    }
    await app.daemon.renameSession(sessionId, "Renamed while the dialog is open");
    await reopened.waitForView(() => getByRole(renamedDialog, "button", { name: "Renamed while the dialog is open" }));
    await reopened.waitForView(() => getByRole(renamedDialog, "heading", { name: "Renamed while the dialog is open" }));
});

test("Given a conversation is being reopened, When the title has not loaded yet, Then the header shows a skeleton instead of naming the conversation and withdrawing it", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await sendPrompt(app, await readyComposer(app), "Reopen this conversation");
    await app.waitForView(() => expect(directoryTitles(app)).toHaveLength(1));
    const conversation = app.elementsByTestId(dataTestId.managedConversation)[0];
    if (conversation === undefined) {
        throw new Error("Expected the conversation in the directory");
    }
    await app.user.click(conversation);
    await app.waitForView(() => expect(app.elementsByTestId(dataTestId.userMessage).length).toBeGreaterThan(0));

    // A title that is already on screen while the messages are still loading is
    // withdrawn again as soon as the loaded pane waits for its own read.
    const statedTitles: string[] = [];
    const read = () => {
        const section = document.querySelector('section[aria-label="Conversation"]');
        const header = section?.querySelector("header") ?? null;
        if (header === null) {
            return;
        }
        const messagesLoading =
            section?.querySelector('[role="log"] [role="status"][aria-label="Loading messages"]') !== null;
        const titleLoading = header.querySelector('[aria-label="Loading conversation title"]') !== null;
        const stated = (header.textContent ?? "").trim();
        if (messagesLoading === true && titleLoading === false && stated.length > 0 && !statedTitles.includes(stated)) {
            statedTitles.push(stated);
        }
    };
    const observer = new MutationObserver(read);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    onTestFinished(() => observer.disconnect());

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.chatLanding)).not.toBeNull());
    const reopened = app.elementsByTestId(dataTestId.managedConversation)[0];
    if (reopened === undefined) {
        throw new Error("Expected the conversation in the directory");
    }
    await app.user.click(reopened);
    // The title is stated only once the same read that loads the messages has settled.
    await app.waitForView(
        () =>
            expect(
                document.querySelector(
                    'section[aria-label="Conversation"] header [aria-label="Loading conversation title"]',
                ),
            ).toBeNull(),
        30_000,
    );
    observer.disconnect();
    expect(statedTitles).toEqual([]);
});
