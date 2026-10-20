import { getByRole, getByText, queryAllByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { flushSync } from "react-dom";
import { expect, onTestFinished, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a conversation created from a queued first message, When the Chat application remounts, Then the prompt is delivered exactly once", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "Queue this first message");
    // The conversation opens from the queued message; wait for the reply so
    // the turn completes before the remount releases the selection.
    await app.waitForView(() => {
        expect(
            app
                .elementsByTestId(dataTestId.userMessage)
                .some((element) => element.textContent === "Queue this first message"),
        ).toBe(true);
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Codex turn 1: Queue this first message")),
        ).toBe(true);
    });
    app.remount();
    await app.waitForView(() => {
        const delivered = app
            .elementsByTestId(dataTestId.userMessage)
            .filter((element) => element.textContent === "Queue this first message");
        expect(delivered).toHaveLength(1);
    });
});

test("Given an open conversation, When the chat view detaches and re-attaches, Then the pane re-reads the session and restores its history", {
    timeout: 30_000,
}, async () => {
    const prompt = "Restore this conversation after re-attach";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`)),
        ).toBe(true),
    );
    app.remount();
    // The re-attached view must show the persisted conversation again from
    // the re-read session, not an empty or stale pane.
    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.userMessage).some((element) => element.textContent === prompt)).toBe(
            true,
        ),
    );
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`)),
        ).toBe(true),
    );
});

test("Given conversations updated across recent dates, When the directory loads, Then conversations are grouped by latest activity", {
    timeout: 60_000,
}, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
        vi.setSystemTime(new Date("2026-10-10T12:00:00+08:00"));
        const app = await createTestApp({ connectAgent: true });
        await app.queryElementByTestId(
            dataTestId.botConnectionStatus,
            (element) => element.textContent?.includes("Connected") === true,
        );
        const conversations = [
            { title: "Today conversation", updatedAt: "2026-10-10T12:00:00+08:00" },
            { title: "September conversation", updatedAt: "2026-09-02T12:00:00+08:00" },
            { title: "Previous 30 days conversation", updatedAt: "2026-10-02T12:00:00+08:00" },
            { title: "Previous 7 days conversation", updatedAt: "2026-10-06T12:00:00+08:00" },
            { title: "Yesterday conversation", updatedAt: "2026-10-09T12:00:00+08:00" },
        ] as const;
        for (const [index, conversation] of conversations.entries()) {
            vi.setSystemTime(new Date(conversation.updatedAt));
            if (index > 0) {
                await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
            }
            const composer = await app.queryElementByTestId(dataTestId.messageComposer);
            if (!(composer instanceof HTMLTextAreaElement)) {
                throw new Error("Expected the message composer");
            }
            await sendPrompt(app, composer, conversation.title);
            await app.waitForView(() =>
                expect(
                    app
                        .elementsByTestId(dataTestId.agentResponse)
                        .some((element) => element.textContent?.includes(conversation.title) === true),
                ).toBe(true),
            );
            await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
        }

        vi.setSystemTime(new Date("2026-10-10T12:00:00+08:00"));
        await app.user.click(getByRole(document.body, "button", { name: "Refresh sessions" }));

        await app.waitForView(() => {
            expect(
                queryAllByRole(document.body, "heading", { level: 3 }).map((heading) => heading.textContent),
            ).toEqual(["Today", "Yesterday", "Previous 7 Days", "Previous 30 Days", "September 2026"]);
            expect(
                app
                    .elementsByTestId(dataTestId.managedConversation)
                    .map(
                        (conversation) =>
                            conversations.find(({ title }) => conversation.textContent?.includes(title) === true)
                                ?.title,
                    ),
            ).toEqual([
                "Today conversation",
                "Yesterday conversation",
                "Previous 7 days conversation",
                "Previous 30 days conversation",
                "September conversation",
            ]);
        });
    } finally {
        vi.useRealTimers();
    }
});

test("Given an unsent message draft, When the Chat application remounts, Then the draft remains in the composer", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await app.user.type(composer, "Keep this unsent draft");
    app.remount();
    const restored = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(restored instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the restored message composer");
    }
    await app.waitForView(() => expect(restored.value).toBe("Keep this unsent draft"));
});

test("Given a completed turn, When the user leaves and reopens it, Then daemon history restores one conversation", {
    timeout: 30_000,
}, async () => {
    const prompt = "Persist this completed conversation";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true),
        ).toBe(true),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const conversation = await app.waitForView(() => {
        const candidate = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => element.textContent?.includes(prompt) === true);
        if (candidate === undefined) {
            throw new Error(`The completed conversation is unavailable: ${document.body.textContent}`);
        }
        return candidate;
    });
    await app.user.click(conversation);
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([prompt]);
        const replies = app
            .elementsByTestId(dataTestId.agentResponse)
            .filter((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true);
        expect(replies).toHaveLength(1);
        expect(replies[0]?.textContent).toContain(`Codex turn 1: ${prompt}`);
    });
    expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
});

test("Given a saved Session, When the user opens its context menu, Then the Session can be closed", {
    timeout: 30_000,
}, async () => {
    const prompt = "Show the close Session action";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    const conversation = await app.queryElementByTestId(
        dataTestId.managedConversation,
        (element) => element.textContent?.includes(prompt) === true,
    );

    await app.user.pointer({ keys: "[MouseRight]", target: conversation });

    await app.waitForView(() => {
        expect(queryByRole(document.body, "menuitem", { name: "Close session" })).not.toBeNull();
        expect(queryByRole(document.body, "menuitem", { name: "Archive session" })).toBeNull();
    });
});

test("Given a named conversation, When the user opens it, Then the Session title heads the conversation", {
    timeout: 30_000,
}, async () => {
    const title = "Show the Session title in the conversation header";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, title);

    await app.waitForView(() =>
        expect(queryByRole(document.body, "heading", { level: 2, name: title })).not.toBeNull(),
    );
});

test("Given a new conversation titled from its prompt, When the Agent generates a title, Then the new title replaces it in the header and directory", {
    timeout: 30_000,
}, async () => {
    const promptTitle = "Use the Agent generated title";
    const agentTitle = "Agent generated title";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, promptTitle);

    await app.waitForView(() => {
        expect(queryByRole(document.body, "heading", { level: 2, name: agentTitle })).not.toBeNull();
        expect(queryByRole(document.body, "heading", { level: 2, name: promptTitle })).toBeNull();
        expect(
            app
                .elementsByTestId(dataTestId.managedConversation)
                .some((conversation) => conversation.textContent?.includes(agentTitle) === true),
        ).toBe(true);
    });
});

test("Given an open conversation, When the user renames it from the header, Then the new title heads the conversation and its directory entry", {
    timeout: 30_000,
}, async () => {
    const prompt = "Rename this conversation from the header";
    const renamed = "Renamed from the header";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(queryByRole(document.body, "heading", { level: 2, name: prompt })).not.toBeNull(),
    );
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true),
        ).toBe(true),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());

    await app.user.click(getByRole(document.body, "button", { name: prompt }));
    await app.waitForView(() =>
        expect(queryByRole(document.body, "textbox", { name: "Conversation title" })).not.toBeNull(),
    );
    const input = getByRole(document.body, "textbox", { name: "Conversation title" });
    await app.user.clear(input);
    await app.user.type(input, renamed);
    await app.user.click(getByRole(document.body, "button", { name: "Save title" }));

    await app.waitForView(() => {
        expect(queryByRole(document.body, "heading", { level: 2, name: renamed })).not.toBeNull();
        expect(queryByRole(document.body, "heading", { level: 2, name: prompt })).toBeNull();
        expect(
            app
                .elementsByTestId(dataTestId.managedConversation)
                .some((conversation) => conversation.textContent?.includes(renamed) === true),
        ).toBe(true);
    });
});

test("Given the header title editor is open, When the user cancels, Then the conversation keeps its title", {
    timeout: 30_000,
}, async () => {
    const prompt = "Keep this title when the rename is cancelled";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(queryByRole(document.body, "heading", { level: 2, name: prompt })).not.toBeNull(),
    );

    await app.user.click(getByRole(document.body, "button", { name: prompt }));
    await app.waitForView(() =>
        expect(queryByRole(document.body, "textbox", { name: "Conversation title" })).not.toBeNull(),
    );
    const input = getByRole(document.body, "textbox", { name: "Conversation title" });
    await app.user.clear(input);
    await app.user.type(input, "Discarded title");
    await app.user.click(getByRole(document.body, "button", { name: "Cancel rename" }));

    await app.waitForView(() => {
        expect(queryByRole(document.body, "heading", { level: 2, name: prompt })).not.toBeNull();
        expect(queryByRole(document.body, "textbox", { name: "Conversation title" })).toBeNull();
    });
});

test("Given Claude Code does not echo the submitted prompt, When the response starts, Then my message is visible once", {
    timeout: 30_000,
}, async () => {
    const prompt = "Show this prompt without an Agent echo";
    const app = await createTestApp({
        connectAgent: true,
        agent: { id: "claude-code", label: "Claude Code" },
    });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, prompt);

    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([prompt]);
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true),
        ).toBe(true);
    });
});

test("Given more saved messages than one history page, When live output arrives while the user loads more, Then older and live messages remain visible", {
    timeout: 90_000,
}, async () => {
    const prompts = Array.from({ length: 7 }, (_, index) => `many session events: Pagination message ${index + 1}`);
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    for (const [index, prompt] of prompts.entries()) {
        const composer = await app.queryElementByTestId(dataTestId.messageComposer);
        if (!(composer instanceof HTMLTextAreaElement)) {
            throw new Error("Expected the message composer");
        }
        await sendPrompt(app, composer, prompt);
        await app.waitForView(() =>
            expect(
                app
                    .elementsByTestId(dataTestId.agentResponse)
                    .some(
                        (element) =>
                            element.textContent?.includes(`Completed Pagination message ${index + 1}`) === true,
                    ),
            ).toBe(true),
        );
        await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    }

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const conversation = await app.waitForView(() => {
        const candidate = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => element.textContent?.includes(prompts[0] ?? "") === true);
        if (candidate === undefined) {
            throw new Error(`The completed conversation is unavailable: ${document.body.textContent}`);
        }
        return candidate;
    });
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    onTestFinished(() => {
        vi.useRealTimers();
    });
    await app.user.click(conversation);
    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toContain(
            prompts.at(-1),
        ),
    );
    const page = {
        prompts: app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent ?? ""),
        responses: app
            .elementsByTestId(dataTestId.agentResponse)
            .map((element) => element.textContent ?? "")
            .filter((text) => text.includes("Completed Pagination message")),
    };
    const expectOmittedReasoning = async () => {
        const reasoningItems = app.elementsByTestId(dataTestId.agentReasoning);
        expect(reasoningItems.length).toBeGreaterThan(0);
        for (const reasoning of reasoningItems) {
            if (reasoning instanceof HTMLDetailsElement && !reasoning.open) {
                await app.user.click(getByText(reasoning, "Show Thinking"));
            }
        }
        await app.waitForView(() => {
            expect(
                reasoningItems.every(
                    (reasoning) =>
                        reasoning.textContent?.includes("(Reasoning details were omitted.)") === true &&
                        !reasoning.textContent.includes("Reasoning step 000.") &&
                        !reasoning.textContent.includes("Reasoning step 039."),
                ),
            ).toBe(true);
        });
    };
    expect(page.prompts).not.toContain(prompts[0]);
    expect(page.prompts.at(-1)).toBe(prompts.at(-1));
    expect(
        page.responses.some(
            (response) =>
                response.includes("Completed Pagination message 1") &&
                !response.includes(`Completed Pagination message ${prompts.length.toString()}`),
        ),
    ).toBe(false);
    expect(page.responses.at(-1)).toContain(`Completed Pagination message ${prompts.length.toString()}`);
    await expectOmittedReasoning();
    await app.waitForView(() =>
        expect(getByRole(document.body, "textbox", { name: "Message" }).hasAttribute("disabled")).toBe(false),
    );
    const composer = getByRole(document.body, "textbox", { name: "Message" });
    if (!(composer instanceof HTMLTextAreaElement) || app.daemon === null) {
        throw new Error("Expected the message composer and controlled Agent");
    }
    const livePrompt = "hold after first delta";
    await sendPrompt(app, composer, livePrompt);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Partial reply") === true),
        ).toBe(true),
    );
    const messages = queryByRole(document.body, "log", { name: "Messages" });
    if (!(messages instanceof HTMLElement)) {
        throw new Error("Expected the Session message list");
    }
    messages.scrollTop = 0;
    flushSync(() => messages.dispatchEvent(new Event("scroll", { bubbles: true })));
    getByRole(document.body, "status", { name: "Loading older messages" });
    await app.daemon.continueReply(livePrompt, {
        outcome: "complete",
        output: [{ kind: "text", text: "Live completion while older messages load" }],
    });
    await app.waitForView(() => {
        const loadedPrompts = app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent);
        const loadedResponses = app
            .elementsByTestId(dataTestId.agentResponse)
            .map((element) => element.textContent ?? "");
        expect(loadedPrompts.length).toBeGreaterThan(page.prompts.length + 1);
        expect(loadedPrompts.slice(-(page.prompts.length + 1), -1)).toEqual(page.prompts);
        expect(loadedPrompts.at(-1)).toBe(livePrompt);
        expect(loadedResponses.some((response) => response.includes("Live completion while older messages load"))).toBe(
            true,
        );
    });
    const loadedPrompts = app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent ?? "");
    const loadedResponses = app.elementsByTestId(dataTestId.agentResponse).map((element) => element.textContent ?? "");
    const firstInitialPromptIndex = prompts.indexOf(page.prompts[0] ?? "");
    const newlyLoadedPrompt = prompts[firstInitialPromptIndex - 1];
    expect(newlyLoadedPrompt).toBeDefined();
    expect(loadedPrompts[0]).toBe(newlyLoadedPrompt);
    expect(loadedPrompts.at(-1)).toBe(livePrompt);
    expect(
        loadedResponses.some(
            (response) =>
                response.includes(`Completed Pagination message ${firstInitialPromptIndex.toString()}`) &&
                !response.includes(`Completed Pagination message ${prompts.length.toString()}`),
        ),
    ).toBe(true);
    expect(loadedResponses.some((response) => response.includes("Live completion while older messages load"))).toBe(
        true,
    );
    await expectOmittedReasoning();
    vi.useRealTimers();
});

test("Given more saved messages than one history page, When older messages load, Then a skeleton placeholder stands in for them instead of a text label", {
    timeout: 90_000,
}, async () => {
    const prompts = Array.from({ length: 7 }, (_, index) => `many session events: Skeleton message ${index + 1}`);
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    for (const [index, prompt] of prompts.entries()) {
        const composer = await app.queryElementByTestId(dataTestId.messageComposer);
        if (!(composer instanceof HTMLTextAreaElement)) {
            throw new Error("Expected the message composer");
        }
        await sendPrompt(app, composer, prompt);
        await app.waitForView(() =>
            expect(
                app
                    .elementsByTestId(dataTestId.agentResponse)
                    .some(
                        (element) => element.textContent?.includes(`Completed Skeleton message ${index + 1}`) === true,
                    ),
            ).toBe(true),
        );
        await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    }

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const conversation = await app.waitForView(() => {
        const candidate = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => element.textContent?.includes(prompts[0] ?? "") === true);
        if (candidate === undefined) {
            throw new Error(`The completed conversation is unavailable: ${document.body.textContent}`);
        }
        return candidate;
    });
    await app.user.click(conversation);
    await app.waitForView(() =>
        expect(getByRole(document.body, "textbox", { name: "Message" }).hasAttribute("disabled")).toBe(false),
    );
    const messages = queryByRole(document.body, "log", { name: "Messages" });
    if (!(messages instanceof HTMLElement)) {
        throw new Error("Expected the Session message list");
    }
    act(() => {
        messages.scrollTop = 0;
        messages.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(getByRole(document.body, "status", { name: "Loading older messages" }).textContent).not.toContain("Loading");

    await app.waitForView(() => {
        expect(
            app
                .elementsByTestId(dataTestId.userMessage)
                .map((element) => element.textContent)
                .includes(prompts[0] ?? ""),
        ).toBe(true);
        expect(queryByRole(document.body, "status", { name: "Loading older messages" })).toBeNull();
    });
});

test("Given a stale Session link, When the user opens it, Then the Session failure replaces the empty landing", {
    timeout: 30_000,
}, async () => {
    const sessionId = `chat_${"0".repeat(64)}`;
    const app = await createTestApp({
        connectAgent: true,
        page: { kind: "managed-session", sessionId },
    });

    const failure = await app.queryElementByTestId(dataTestId.sessionLoadFailure);
    expect(failure.getAttribute("role")).toBe("alert");
    expect(app.optionalElementByTestId(dataTestId.chatLanding)).toBeNull();
});

test("Given a completed turn, When I send another prompt, Then my prompt is visible once while the next reply is still streaming", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected composer");
    }
    await sendPrompt(app, composer, "First completed turn");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Codex turn 1: First completed turn") === true),
        ).toBe(true),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    const continuedComposer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(continuedComposer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected composer");
    }
    await sendPrompt(app, continuedComposer, "hold after first delta");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Partial reply") === true),
        ).toBe(true),
    );
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            "First completed turn",
            "hold after first delta",
        ]);
        expect(app.optionalElementByTestId(dataTestId.sessionStatus)).not.toBeNull();
    });
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
});
