import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given an unsent message draft, When the user reloads Chat, Then the draft remains in the composer", {
    timeout: 30_000,
}, async () => {
    const created = await createTestApp({ connectAgent: true });
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = (await created.queryElementByTestId(dataTestId.messageComposer)) as HTMLTextAreaElement;

    await created.user.type(composer, "Keep this unsent draft");
    created.reload();

    const restored = (await created.queryElementByTestId(dataTestId.messageComposer)) as HTMLTextAreaElement;
    await vi.waitFor(() => expect(restored.value).toBe("Keep this unsent draft"));
});

test("Given OpenCode completed without mapping native history to the command, When the user reopens it without an active Runtime turn, Then the conversation is idle", {
    timeout: 30_000,
}, async () => {
    const releaseTurn = Promise.withResolvers<void>();
    const turnReleased = Promise.withResolvers<void>();
    let completed = false;
    const prompt = "Finish while this conversation is closed";
    const answer = "The task completed while the conversation was closed.";
    const created = await createTestApp({
        agentBehavior: {
            agentId: "codex",
            additionalAgents: [{ id: "opencode", name: "OpenCode" }],
            afterLastDelta: async (_command, signal) => {
                await Promise.race([
                    releaseTurn.promise,
                    new Promise<never>((_resolve, reject) =>
                        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
                    ),
                ]);
                completed = true;
                turnReleased.resolve();
            },
            loadNativeHistory: async (_sessionId, signal) => {
                signal.throwIfAborted();
                return {
                    coveredCommandIds: [],
                    coveredMessageIds: [],
                    messages: completed
                        ? [
                              { role: "user", text: prompt },
                              { activities: [], content: [], role: "assistant", text: answer },
                          ]
                        : [],
                    status: "available",
                    truncated: false,
                };
            },
            responseParts: () => [answer],
        },
        connectAgent: true,
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    await created.user.click(await created.queryElementByTestId(dataTestId.agentConfiguration));
    await created.user.click(getByRole(document.body, "tab", { name: "OpenCode" }));
    await created.user.keyboard("{Escape}");
    await created.queryElementByTestId(
        dataTestId.agentConfiguration,
        (element) => element.textContent?.includes("OpenCode") === true,
    );
    const composer = await created.queryElementByTestId(dataTestId.messageComposer);

    await sendPrompt(created, composer as HTMLTextAreaElement, prompt);
    await Promise.race([
        created.queryElementByTestId(
            dataTestId.agentResponse,
            (element) => element.textContent?.includes(answer) === true,
        ),
        failure,
    ]);
    await created.user.click(await created.queryElementByTestId(dataTestId.newConversation));
    releaseTurn.resolve();
    await turnReleased.promise;
    const completedConversation = await vi.waitFor(() => {
        const conversation = created
            .elementsByTestId(dataTestId.managedConversation)
            .find((candidate) => candidate.textContent?.includes(prompt) === true);
        if (conversation === undefined) {
            throw new Error(`The completed conversation is unavailable: ${document.body.textContent}`);
        }
        return conversation;
    });
    await created.user.click(completedConversation);
    await vi.waitFor(() => {
        expect(
            created
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(answer) === true),
        ).toBe(true);
    });

    await vi.waitFor(() => {
        expect(created.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
        expect(created.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        expect(created.optionalElementByTestId(dataTestId.agentReplyStatus)).toBeNull();
    });
});

test("Given a Bot connected to a multi-agent Runtime, When the user reloads an OpenCode conversation, Then its native history remains visible", {
    timeout: 30_000,
}, async () => {
    const prompt = "Restore this OpenCode conversation";
    const answer = "This OpenCode conversation was restored.";
    const releaseHistory = Promise.withResolvers<void>();
    let completed = false;
    let holdHistory = false;
    const created = await createTestApp({
        agentBehavior: {
            agentId: "codex",
            additionalAgents: [{ id: "opencode", name: "OpenCode" }],
            loadNativeHistory: async (_sessionId, signal) => {
                signal.throwIfAborted();
                if (holdHistory) {
                    await Promise.race([
                        releaseHistory.promise,
                        new Promise<never>((_resolve, reject) =>
                            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
                        ),
                    ]);
                }
                return {
                    coveredCommandIds: [],
                    coveredMessageIds: [],
                    messages: completed
                        ? [
                              { role: "user", text: prompt },
                              { activities: [], content: [], role: "assistant", text: answer },
                          ]
                        : [],
                    status: "available",
                    truncated: false,
                };
            },
            onPromptCompleted: () => {
                completed = true;
            },
            responseParts: () => [answer],
        },
        connectAgent: true,
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    await created.user.click(await created.queryElementByTestId(dataTestId.agentConfiguration));
    await created.user.click(getByRole(document.body, "tab", { name: "OpenCode" }));
    await created.user.keyboard("{Escape}");
    const configuration = await created.queryElementByTestId(
        dataTestId.agentConfiguration,
        (element) => element.textContent?.includes("OpenCode") === true,
    );
    expect(configuration.textContent).not.toContain("Codex");

    await sendPrompt(
        created,
        (await created.queryElementByTestId(dataTestId.messageComposer)) as HTMLTextAreaElement,
        prompt,
    );
    await Promise.race([
        created.queryElementByTestId(
            dataTestId.agentResponse,
            (element) => element.textContent?.includes(answer) === true,
        ),
        failure,
    ]);
    await vi.waitFor(() => expect(created.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    expect(queryByRole(document.body, "button", { name: "More options" })).toBeNull();

    holdHistory = true;
    created.reload();

    expect(await vi.waitFor(() => getByRole(document.body, "status", { name: "Loading messages" }))).toBeInstanceOf(
        HTMLElement,
    );
    expect(created.elementByTestId(dataTestId.botConnectionStatus).textContent).toBe("Connected");
    releaseHistory.resolve();

    expect(
        await created.queryElementByTestId(
            dataTestId.userMessage,
            (element) => element.textContent?.includes(prompt) === true,
        ),
    ).toBeInstanceOf(HTMLElement);
    expect(
        await created.queryElementByTestId(
            dataTestId.agentResponse,
            (element) => element.textContent?.includes(answer) === true,
        ),
    ).toBeInstanceOf(HTMLElement);
});

test("Given an Agent advertises compact, When the user chooses Compact context, Then the compact turn is visible", {
    timeout: 30_000,
}, async () => {
    const prompt = "Prepare the workspace context";
    const answer = "The workspace context is ready.";
    const compactAnswer = "Context compacted.";
    const created = await createTestApp({
        agentBehavior: {
            commands: [{ description: "Compact the current conversation", inputHint: "", name: "compact" }],
            responseParts: (command) => (command.prompt === "/compact" ? [compactAnswer] : [answer]),
        },
        connectAgent: true,
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );

    await sendPrompt(
        created,
        (await created.queryElementByTestId(dataTestId.messageComposer)) as HTMLTextAreaElement,
        prompt,
    );
    await Promise.race([
        created.queryElementByTestId(
            dataTestId.agentResponse,
            (element) => element.textContent?.includes(answer) === true,
        ),
        failure,
    ]);
    await vi.waitFor(() => expect(created.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());

    await created.user.click(getByRole(document.body, "button", { name: "More options" }));
    await created.user.click(getByRole(document.body, "menuitem", { name: "Compact context" }));

    await Promise.race([
        vi.waitFor(() => {
            expect(
                created
                    .elementsByTestId(dataTestId.userMessage)
                    .some((element) => element.textContent?.includes("/compact") === true),
            ).toBe(true);
            expect(
                created
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((element) => element.textContent?.includes(compactAnswer) === true),
            ).toBe(true);
            expect(document.body.textContent).not.toContain("Agent finished without a text response.");
        }),
        failure,
    ]);
});

test("Given a completed conversation, When the user reopens it and sends another message, Then the Agent continues the chat", {
    timeout: 30_000,
}, async () => {
    const completedTurns: { readonly commandId: string; readonly prompt: string; readonly response: string }[] = [];
    const created = await createTestApp({
        agentBehavior: {
            loadNativeHistory: async (_sessionId, signal) => {
                signal.throwIfAborted();
                return {
                    coveredCommandIds: completedTurns.map((turn) => turn.commandId),
                    coveredMessageIds: [],
                    messages: completedTurns.flatMap((turn) => [
                        { role: "user" as const, text: turn.prompt },
                        { activities: [], content: [], role: "assistant" as const, text: turn.response },
                    ]),
                    status: "available",
                    truncated: false,
                };
            },
            onPromptCompleted: (command, response) => {
                completedTurns.push({ commandId: command.commandId, prompt: command.prompt, response });
            },
            responseParts: (command) => [`Reply to: ${command.prompt}`],
        },
        connectAgent: true,
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );

    await sendPrompt(
        created,
        (await created.queryElementByTestId(dataTestId.messageComposer)) as HTMLTextAreaElement,
        "First message",
    );
    await Promise.race([
        created.queryElementByTestId(
            dataTestId.agentResponse,
            (element) => element.textContent?.includes("Reply to: First message") === true,
        ),
        failure,
    ]);
    await vi.waitFor(() => expect(created.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await created.user.click(await created.queryElementByTestId(dataTestId.newConversation));
    const conversation = await vi.waitFor(() => {
        const candidate = created
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => element.textContent?.includes("First message") === true);
        if (candidate === undefined) {
            throw new Error(`The completed conversation is unavailable: ${document.body.textContent}`);
        }
        return candidate;
    });
    await created.user.click(conversation);
    await created.queryElementByTestId(
        dataTestId.agentResponse,
        (element) => element.textContent?.includes("Reply to: First message") === true,
    );
    await vi.waitFor(() => expect(created.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    const reopenedComposer = (await created.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => !(element as HTMLTextAreaElement).disabled,
    )) as HTMLTextAreaElement;
    await created.queryElementByTestId(
        dataTestId.sendMessage,
        (element) => element.getAttribute("aria-label") === "Send message",
    );

    await sendPrompt(created, reopenedComposer, "Continue after reopening");
    await vi.waitFor(() => expect(reopenedComposer.value).toBe(""));
    await vi.waitFor(() =>
        expect(
            created
                .elementsByTestId(dataTestId.userMessage)
                .some((element) => element.textContent?.includes("Continue after reopening") === true),
        ).toBe(true),
    );
    await Promise.race([
        vi.waitFor(() =>
            expect(
                created
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((element) => element.textContent?.includes("Reply to: Continue after reopening") === true),
            ).toBe(true),
        ),
        failure,
    ]);
    await vi.waitFor(() => expect(created.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
});

test("Given an open conversation, When another Agent response arrives, Then the visible timeline remains without a loading skeleton", {
    timeout: 30_000,
}, async () => {
    const completedTurns: { readonly commandId: string; readonly prompt: string; readonly response: string }[] = [];
    const created = await createTestApp({
        agentBehavior: {
            loadNativeHistory: async (_sessionId, signal) => {
                signal.throwIfAborted();
                return {
                    coveredCommandIds: completedTurns.map((turn) => turn.commandId),
                    coveredMessageIds: [],
                    messages: completedTurns.flatMap((turn) => [
                        { role: "user" as const, text: turn.prompt },
                        { activities: [], content: [], role: "assistant" as const, text: turn.response },
                    ]),
                    status: "available",
                    truncated: false,
                };
            },
            onPromptCompleted: (command, response) => {
                completedTurns.push({ commandId: command.commandId, prompt: command.prompt, response });
            },
            responseParts: (command) => [`Reply to: ${command.prompt}`],
        },
        connectAgent: true,
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = (await created.queryElementByTestId(dataTestId.messageComposer)) as HTMLTextAreaElement;

    await sendPrompt(created, composer, "Keep this timeline visible");
    await Promise.race([
        created.queryElementByTestId(
            dataTestId.agentResponse,
            (element) => element.textContent?.includes("Reply to: Keep this timeline visible") === true,
        ),
        failure,
    ]);
    await vi.waitFor(() => expect(created.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());

    let switchingVisible = false;
    const observer = new MutationObserver((records) => {
        switchingVisible ||= records.some((record) =>
            [...record.addedNodes].some(
                (node) =>
                    node instanceof Element &&
                    (node.matches('[role="status"][aria-label="Switching session"]') ||
                        node.querySelector('[role="status"][aria-label="Switching session"]') !== null),
            ),
        );
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const continuedComposer = (await created.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => !(element as HTMLTextAreaElement).disabled,
    )) as HTMLTextAreaElement;
    await sendPrompt(created, continuedComposer, "Trigger a workspace refresh");
    await Promise.race([
        vi.waitFor(() =>
            expect(
                created
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((element) => element.textContent?.includes("Reply to: Trigger a workspace refresh") === true),
            ).toBe(true),
        ),
        failure,
    ]);
    observer.disconnect();

    expect(
        created
            .elementsByTestId(dataTestId.agentResponse)
            .some((element) => element.textContent?.includes("Reply to: Keep this timeline visible") === true),
    ).toBe(true);
    expect(switchingVisible).toBe(false);
});
