import { queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

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

test("Given more saved messages than one history page, When the user reaches the top of a reopened conversation, Then at least twenty older messages load or history is exhausted", {
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
    const firstHistoryPage = new Promise<{
        readonly prompts: readonly string[];
        readonly responses: readonly string[];
    }>((resolve) => {
        let loadingObserved = false;
        const observe = () => {
            const loading = queryByRole(document.body, "status", { name: "Loading messages" });
            loadingObserved ||= loading !== null;
            if (!loadingObserved || loading !== null) {
                return;
            }
            observer.disconnect();
            resolve({
                prompts: app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent ?? ""),
                responses: app
                    .elementsByTestId(dataTestId.agentResponse)
                    .map((element) => element.textContent ?? "")
                    .filter((text) => text.includes("Completed Pagination message")),
            });
        };
        const observer = new MutationObserver(observe);
        observer.observe(document.body, { childList: true, subtree: true });
        observe();
    });
    await app.user.click(conversation);

    const page = await firstHistoryPage;
    expect(page.prompts).not.toContain(prompts[0]);
    expect(page.prompts.at(-1)).toBe(prompts.at(-1));
    expect(page.responses.some((response) => response.includes("Completed Pagination message 1"))).toBe(false);
    expect(page.responses.at(-1)).toContain(`Completed Pagination message ${prompts.length.toString()}`);
    const messages = queryByRole(document.body, "log", { name: "Messages" });
    if (!(messages instanceof HTMLElement)) {
        throw new Error("Expected the Session message list");
    }
    messages.scrollTop = 0;
    messages.dispatchEvent(new Event("scroll", { bubbles: true }));
    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual(prompts),
    );
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
