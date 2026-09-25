import { getAllByRole, getByLabelText, getByRole, queryByRole, queryByTestId } from "@testing-library/dom";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { closeTestApps, closeTestEnvironment, createTestApp, type TestApp } from "./infra/test-app.tsx";

afterEach(async () => {
    await closeTestApps();
    document.body.replaceChildren();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
});

afterAll(async () => {
    await closeTestEnvironment();
});

function observeTestId(testId: string): Promise<HTMLElement> {
    return new Promise((resolve) => {
        const observer = new MutationObserver(() => {
            const element = queryByTestId(document.body, testId);
            if (element !== null) {
                observer.disconnect();
                resolve(element);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });
}

test("Given a native session handoff, When importing fails, Then the choice page shows progress and allows a fork retry", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: {
            harness: "codex",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });
    const importSession = await vi.waitFor(() => getByRole(document.body, "button", { name: "Import session" }));
    const forkSession = getByRole(document.body, "button", { name: "Fork session" });
    if (!(importSession instanceof HTMLButtonElement) || !(forkSession instanceof HTMLButtonElement)) {
        throw new Error("The native session actions are not buttons.");
    }

    await app.user.click(importSession);

    expect(importSession.disabled).toBe(true);
    expect(forkSession.disabled).toBe(true);
    expect(getByRole(importSession, "status", { name: "Importing session" })).toBeInstanceOf(HTMLElement);
    expect(queryByRole(document.body, "status", { name: "Securely transferring the workspace" })).toBeNull();

    await vi.waitFor(() => expect(getByRole(document.body, "alert")).toBeInstanceOf(HTMLElement));
    expect(getByRole(document.body, "heading", { name: "Continue native session" })).toBeInstanceOf(HTMLElement);
    expect(importSession.disabled).toBe(false);
    expect(forkSession.disabled).toBe(false);

    await app.user.click(forkSession);

    expect(getByRole(forkSession, "status", { name: "Forking session" })).toBeInstanceOf(HTMLElement);
});

async function sendPrompt(app: TestApp, composer: HTMLTextAreaElement, prompt: string): Promise<void> {
    await app.user.click(composer);
    await app.user.paste(prompt);
    const send = await app.queryElementByTestId(
        dataTestId.sendMessage,
        (element) => element instanceof HTMLButtonElement && !element.disabled,
    );
    await app.user.click(send);
}

test("Given a shared workspace, When the user opens the user menu, Then they can back up their token before replacing the current user", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    await app.user.click(await app.queryElementByTestId(dataTestId.userMenu));
    await app.user.click(await app.queryElementByTestId(dataTestId.replaceCurrentUser));

    const dialog = await app.queryElementByTestId(dataTestId.replaceCurrentUserDialog);
    expect(dialog.textContent).toContain("Replace current user");
    expect(dialog.textContent).toContain("Back up this token");
    expect(app.elementByTestId(dataTestId.currentUserToken, dialog)).toHaveProperty(
        "value",
        expect.stringMatching(/^mobius_recovery_v1\./u),
    );
    expect(app.elementByTestId(dataTestId.copyUserToken, dialog).getAttribute("aria-label")).toBe(
        "Copy current user token",
    );
    expect(app.elementByTestId(dataTestId.replacementUserToken, dialog).getAttribute("aria-label")).toBe(
        "Replacement user token",
    );
});

test("Given a shared workspace, When the user chooses to end remote access from the user menu, Then they must confirm the transfer-wide revocation and can back up their token", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    const shareMachine = await app.queryElementByTestId(dataTestId.shareMachine);

    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    const userMenu = await app.queryElementByTestId(dataTestId.userMenu);
    expect(userMenu.parentElement).toBe(shareMachine.parentElement);
    await app.user.click(userMenu);
    const endAccess = await app.queryElementByTestId(dataTestId.endRemoteAccess);
    await app.user.click(endAccess);

    const dialog = await app.queryElementByTestId(dataTestId.endRemoteAccessDialog);
    expect(dialog.textContent).toContain("End remote access?");
    expect(dialog.textContent).toContain("every browser using this access link");
    expect(dialog.textContent).toContain("Your local Runtime and task will keep running");
    expect(dialog.textContent).toContain("Back up this token");
    expect(app.elementByTestId(dataTestId.currentUserToken, dialog)).toHaveProperty(
        "value",
        expect.stringMatching(/^mobius_recovery_v1\./u),
    );
    expect(dialog.textContent).toContain("Cancel");
    expect(dialog.textContent).toContain("End remote access");
});

test("Given a conversation is working, When a user starts a new conversation, Then the background conversation keeps its working indicator", {
    timeout: 30_000,
}, async () => {
    const turnStarted = Promise.withResolvers<void>();
    const releaseTurn = Promise.withResolvers<void>();
    const created = await createTestApp({
        agentBehavior: {
            afterSessionStarted: async (...args: [signal: AbortSignal] | [command: unknown, signal: AbortSignal]) => {
                const signal = args.length === 1 ? args[0] : args[1];
                turnStarted.resolve();
                await new Promise<void>((resolve, reject) => {
                    let settled = false;
                    const settle = (complete: () => void): void => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        signal.removeEventListener("abort", abort);
                        complete();
                    };
                    const release = (): void => settle(resolve);
                    const abort = (): void => settle(() => reject(signal.reason));
                    signal.addEventListener("abort", abort, { once: true });
                    void releaseTurn.promise.then(release);
                });
            },
        },
        connectAgent: true,
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await created.queryElementByTestId(dataTestId.messageComposer);

    await sendPrompt(created, composer as HTMLTextAreaElement, "Keep working in the background");
    await Promise.race([turnStarted.promise, failure]);
    await created.queryElementByTestId(dataTestId.sessionStatus);
    await created.user.click(await created.queryElementByTestId(dataTestId.newConversation));

    const backgroundConversation = await vi.waitFor(
        () => {
            const conversations = created.elementsByTestId(dataTestId.managedConversation);
            const conversation = conversations.find((candidate) =>
                candidate.textContent?.includes("Keep working in the background"),
            );
            if (conversation === undefined) {
                throw new Error(`The background conversation is unavailable: ${document.body.textContent}`);
            }
            try {
                created.elementByTestId(dataTestId.sessionStatus, conversation);
            } catch {
                throw new Error(`The background conversation is not shown as working: ${document.body.textContent}`);
            }
            return conversation;
        },
        { timeout: 12_000 },
    );
    expect(backgroundConversation.getAttribute("aria-current")).toBeNull();
    releaseTurn.resolve();
});

test("Given a conversation is working, When the user reopens it, Then its live status and messages are restored", {
    timeout: 30_000,
}, async () => {
    const releaseTurn = Promise.withResolvers<void>();
    const releaseSnapshot = Promise.withResolvers<void>();
    let turnStarted = false;
    const prompt = "Keep this session working while I leave";
    const answer = "The active response remains visible.";
    const progress = "Inspecting the active workspace once.";
    const created = await createTestApp({
        agentBehavior: {
            afterSessionStarted: async (_command, signal) => {
                signal.throwIfAborted();
                turnStarted = true;
            },
            afterLastDelta: async (_command, signal) => {
                await Promise.race([
                    releaseTurn.promise,
                    new Promise<never>((_resolve, reject) =>
                        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
                    ),
                ]);
            },
            beforeActiveTurnSnapshot: async (_sessionId, signal) => {
                if (!turnStarted) {
                    return;
                }
                await Promise.race([
                    releaseSnapshot.promise,
                    new Promise<never>((_resolve, reject) =>
                        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
                    ),
                ]);
            },
            loadNativeHistory: async (_sessionId, signal) => {
                signal.throwIfAborted();
                const inspectWorkspace = {
                    activities: [
                        {
                            activityId: "inspect-workspace",
                            activityType: "tool",
                            content: [],
                            input: "pwd",
                            locations: [],
                            name: "shell",
                            output: "/workspace",
                            sequence: 1,
                            status: "completed",
                            title: "Inspect workspace",
                            toolKind: "shell",
                        },
                    ],
                    content: [],
                    role: "assistant" as const,
                    text: "",
                };
                const createDirectory = {
                    activities: [
                        {
                            activityId: "create-directory",
                            activityType: "tool",
                            content: [],
                            input: "mkdir app",
                            locations: [],
                            name: "shell",
                            output: "",
                            sequence: 2,
                            status: "completed",
                            title: "Create app directory",
                            toolKind: "shell",
                        },
                        {
                            activityId: "fake-progress-1",
                            activityType: "progress",
                            content: [],
                            input: "",
                            locations: [],
                            name: "",
                            output: progress,
                            sequence: 3,
                            status: "completed",
                            title: "Progress update",
                            toolKind: "",
                        },
                    ],
                    content: [],
                    role: "assistant" as const,
                    text: answer,
                };
                return {
                    coveredCommandIds: [],
                    coveredMessageIds: [],
                    messages: turnStarted ? [{ role: "user", text: prompt }, inspectWorkspace, createDirectory] : [],
                    status: "available",
                    truncated: false,
                };
            },
            progressText: () => progress,
            responseParts: () => [answer],
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
    await created.user.click(await created.queryElementByTestId(dataTestId.newConversation));
    const workingConversation = await vi.waitFor(() => {
        const conversation = created
            .elementsByTestId(dataTestId.managedConversation)
            .find((candidate) => candidate.textContent?.includes(prompt) === true);
        if (conversation === undefined) {
            throw new Error(`The working conversation is unavailable: ${document.body.textContent}`);
        }
        return conversation;
    });
    await created.user.click(workingConversation);

    await vi.waitFor(() => {
        expect(created.optionalElementByTestId(dataTestId.sessionStatus)).not.toBeNull();
        expect(created.optionalElementByTestId(dataTestId.agentReplyStatus)).toBeNull();
    });
    releaseSnapshot.resolve();
    await Promise.race([
        Promise.all([
            created.queryElementByTestId(
                dataTestId.userMessage,
                (element) => element.textContent?.includes(prompt) === true,
            ),
            vi.waitFor(() => {
                expect(
                    created
                        .elementsByTestId(dataTestId.agentResponse)
                        .some((element) => element.textContent?.includes(answer) === true),
                ).toBe(true);
            }),
            created.queryElementByTestId(dataTestId.sessionStatus),
        ]),
        failure,
    ]);
    await vi.waitFor(() => {
        expect(
            created
                .elementsByTestId(dataTestId.userMessage)
                .filter((element) => element.textContent?.includes(prompt) === true),
        ).toHaveLength(1);
        const activities = created.elementsByTestId(dataTestId.agentToolCall);
        expect(
            activities.filter((element) => element.textContent?.includes("Inspect workspace") === true),
        ).toHaveLength(1);
        expect(
            activities.filter((element) => element.textContent?.includes("Create app directory") === true),
        ).toHaveLength(1);
        expect(
            created
                .elementsByTestId(dataTestId.agentResponse)
                .filter((element) => element.textContent?.includes(answer) === true),
        ).toHaveLength(1);
        expect((document.body.textContent?.split(progress).length ?? 1) - 1).toBe(1);
    });
    expect(created.optionalElementByTestId(dataTestId.agentReplyStatus)).toBeNull();
    releaseTurn.resolve();
});

test("Given native history has advanced into the next queued turn, When that turn streams, Then its prompt and reply appear once", {
    timeout: 30_000,
}, async () => {
    const finishFirst = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const finishSecond = Promise.withResolvers<void>();
    const firstPrompt = "First queued-history task";
    const secondPrompt = "Second queued-history task";
    let firstStarted = false;
    let completed: { readonly commandId: string; readonly prompt: string; readonly reply: string } | null = null;
    const wait = async (promise: Promise<void>, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        const cancelled = Promise.withResolvers<never>();
        const abort = () => cancelled.reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        try {
            await Promise.race([promise, cancelled.promise]);
        } finally {
            signal.removeEventListener("abort", abort);
        }
    };
    const app = await createTestApp({
        connectAgent: true,
        agentBehavior: {
            responseParts: (command) => [`Reply: ${command.prompt}`],
            afterSessionStarted: async (command) => {
                firstStarted = true;
                if (command.prompt === secondPrompt) {
                    secondStarted.resolve();
                }
            },
            afterLastDelta: (command, signal) =>
                wait(command.prompt === firstPrompt ? finishFirst.promise : finishSecond.promise, signal),
            onPromptCompleted: (command, reply) => {
                completed = { commandId: command.commandId, prompt: command.prompt, reply };
            },
            loadNativeHistory: async (_sessionId, signal) => {
                const first = completed;
                if (first !== null) {
                    await wait(secondStarted.promise, signal);
                }
                return {
                    status: "available",
                    truncated: false,
                    coveredMessageIds: [],
                    coveredCommandIds: first === null ? [] : [first.commandId],
                    messages:
                        first === null
                            ? firstStarted
                                ? [
                                      { role: "user", text: firstPrompt },
                                      { role: "assistant", text: `Reply: ${firstPrompt}`, activities: [], content: [] },
                                  ]
                                : []
                            : [
                                  { role: "user", text: first.prompt },
                                  { role: "assistant", text: first.reply, activities: [], content: [] },
                                  { role: "user", text: secondPrompt },
                              ],
                };
            },
        },
    });
    try {
        await app.queryElementByTestId(
            dataTestId.botConnectionStatus,
            (element) => element.textContent?.includes("Connected") === true,
        );
        const composer = await app.queryElementByTestId(dataTestId.messageComposer);
        if (!(composer instanceof HTMLTextAreaElement)) {
            throw new Error("Missing composer");
        }
        await sendPrompt(app, composer, firstPrompt);
        await app.queryElementByTestId(
            dataTestId.agentResponse,
            (element) => element.textContent?.includes(`Reply: ${firstPrompt}`) === true,
        );
        const viewer = await app.openViewer();
        await viewer.queryElementByTestId(
            dataTestId.agentResponse,
            (element) => element.textContent?.includes(`Reply: ${firstPrompt}`) === true,
        );
        const activeComposer = await viewer.queryElementByTestId(dataTestId.messageComposer);
        await viewer.user.click(activeComposer);
        await viewer.user.type(activeComposer, secondPrompt);
        await viewer.user.click(
            await viewer.queryElementByTestId(
                dataTestId.sendMessage,
                (element) => element.getAttribute("aria-label") === "Send message",
            ),
        );
        await app.queryElementByTestId(dataTestId.queuedMessage);
        finishFirst.resolve();
        for (const current of [app, viewer]) {
            await vi.waitFor(() =>
                expect(
                    current
                        .elementsByTestId(dataTestId.agentResponse)
                        .some((element) => element.textContent?.includes(`Reply: ${secondPrompt}`)),
                ).toBe(true),
            );
            expect(
                current
                    .elementsByTestId(dataTestId.userMessage)
                    .filter((element) => element.textContent?.includes(secondPrompt)),
            ).toHaveLength(1);
            expect(
                current
                    .elementsByTestId(dataTestId.userMessage)
                    .filter((element) => element.textContent?.includes(firstPrompt)),
            ).toHaveLength(1);
        }
    } finally {
        finishFirst.resolve();
        finishSecond.resolve();
    }
});

test("Given a completed conversation was locally recorded as working, When the user reopens it without an active Runtime turn, Then the conversation is idle", {
    timeout: 30_000,
}, async () => {
    const releaseTurn = Promise.withResolvers<void>();
    const turnReleased = Promise.withResolvers<void>();
    let completed = false;
    let completedCommandId: string | null = null;
    const prompt = "Finish while this conversation is closed";
    const answer = "The task completed while the conversation was closed.";
    const created = await createTestApp({
        agentBehavior: {
            afterSessionStarted: async (command, signal) => {
                signal.throwIfAborted();
                completedCommandId = command.commandId;
            },
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
                    coveredCommandIds: completed && completedCommandId !== null ? [completedCommandId] : [],
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

test("Given an unpaired workspace, When a user manages Bots, Then pairing and the surviving Bot remain visible", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    const [landing, pairing] = await Promise.all([
        app.queryElementByTestId(dataTestId.chatLanding),
        app.queryElementByTestId(dataTestId.pairingInstruction),
    ]);
    expect(landing.textContent).toContain("My Bot");
    const conversationSetup = await app.queryElementByTestId(dataTestId.conversationSetupRequired);
    expect(conversationSetup.textContent).toContain("No conversations yet");
    expect(conversationSetup.textContent).toContain("Connect Bot");
    expect(conversationSetup.getAttribute("role")).not.toBe("alert");

    expect(pairing).toBeInstanceOf(HTMLInputElement);
    expect((pairing as HTMLInputElement).value).toMatch(/^follow http:\/\/127\.0\.0\.1:\d+\/pair\.md\?token=/u);

    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    await app.user.click(await app.queryElementByTestId(dataTestId.botMenuTrigger));
    await app.user.click(await app.queryElementByTestId(dataTestId.createBot));
    const name = await app.queryElementByTestId(dataTestId.botNameInput);
    await app.user.type(name, "Laptop Bot");
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.confirmCreateBot,
            (element) => element instanceof HTMLButtonElement && !element.disabled,
        ),
    );
    await app.queryElementByTestId(
        dataTestId.botMenuTrigger,
        (element) => element.textContent?.includes("Laptop Bot") === true,
    );
    await app.user.click(app.elementByTestId(dataTestId.botMenuTrigger));
    await app.user.click(await app.queryElementByTestId(dataTestId.removeBot));
    await app.user.click(await app.queryElementByTestId(dataTestId.confirmRemoveBot));
    await app.queryElementByTestId(
        dataTestId.botMenuTrigger,
        (element) => element.textContent?.includes("My Bot") === true,
    );
    await app.user.click(app.elementByTestId(dataTestId.botMenuTrigger));
    expect(app.optionalElementByTestId(dataTestId.removeBot)).toBeNull();
});

test("Given a paired Bot with cached agent settings, When a user refreshes and filters its models, Then the reloaded configuration and Agent reply are visible", {
    timeout: 30_000,
}, async () => {
    let completed: { readonly commandId: string; readonly prompt: string; readonly reply: string } | null = null;
    const created = await createTestApp({
        connectAgent: true,
        agentBehavior: {
            onPromptCompleted: (command, reply) => {
                completed = { commandId: command.commandId, prompt: command.prompt, reply };
            },
            loadNativeHistory: async (_sessionId, signal) => {
                signal.throwIfAborted();
                return {
                    status: "available",
                    truncated: false,
                    coveredCommandIds: completed === null ? [] : [completed.commandId],
                    coveredMessageIds: [],
                    messages:
                        completed === null
                            ? []
                            : [
                                  { role: "user", text: completed.prompt },
                                  { role: "assistant", text: completed.reply, activities: [], content: [] },
                              ],
                };
            },
        },
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await created.queryElementByTestId(dataTestId.messageComposer);
    expect(composer).toBeInstanceOf(HTMLTextAreaElement);
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
    expect(created.optionalElementByTestId(dataTestId.pairingInstruction)).toBeNull();

    await created.user.click(await created.queryElementByTestId(dataTestId.agentConfiguration));
    const loading = observeTestId(dataTestId.agentSettingsLoading);
    await created.user.click(await created.queryElementByTestId(dataTestId.refreshAgentSettings));
    await loading;
    await created.user.click(
        await created.queryElementByTestId(
            dataTestId.agentSetting("model"),
            (element) => element instanceof HTMLButtonElement && !element.disabled,
        ),
    );
    const search = await created.queryElementByTestId(dataTestId.modelSearch);
    await created.user.type(search, "large");
    await created.queryElementByTestId(
        dataTestId.sessionConfigValue("test-large"),
        (element) => element.textContent?.includes("Test Large") === true,
    );
    expect(created.optionalElementByTestId(dataTestId.sessionConfigValue("test-small"))).toBeNull();
    await created.user.keyboard("{Escape}{Escape}");

    const prompt = "Confirm the refreshed model settings";
    await sendPrompt(created, composer as HTMLTextAreaElement, prompt);
    await Promise.race([
        Promise.all([
            created.queryElementByTestId(
                dataTestId.userMessage,
                (element) => element.textContent?.includes(prompt) === true,
            ),
            created.queryElementByTestId(
                dataTestId.agentResponse,
                (element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true,
            ),
        ]),
        failure,
    ]);
    await vi.waitFor(() => expect(created.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
});

test("Given multiple Runtimes share a Project, When a user configures a paired Bot, Then only its Runtime harnesses are listed", {
    timeout: 30_000,
}, async () => {
    const created = await createTestApp({
        connectAgent: true,
        prepare: async (application) => {
            await application.connectRuntime();
        },
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await Promise.race([
        created.queryElementByTestId(
            dataTestId.botConnectionStatus,
            (element) => element.textContent?.includes("Connected") === true,
        ),
        failure,
    ]);

    await created.user.click(await created.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });

    expect(getAllByRole(configuration, "tab", { name: "Codex" })).toHaveLength(1);
    expect(getAllByRole(configuration, "tab")).toHaveLength(1);
});

test("Given an active reply, When another viewer reloads and deletes queued work, Then both viewers stay synchronized and the user can steer a later message", {
    timeout: 30_000,
}, async () => {
    const continueReply = Promise.withResolvers<void>();
    const finishTurn = Promise.withResolvers<void>();
    const created = await createTestApp({
        agentBehavior: {
            steering: true,
            responseParts: () => ["Before steering.", "After steering."],
            afterFirstDelta: async (_command, signal) => {
                await Promise.race([
                    continueReply.promise,
                    new Promise<never>((_resolve, reject) => {
                        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                    }),
                ]);
            },
            afterLastDelta: async (_command, signal) => {
                await Promise.race([
                    finishTurn.promise,
                    new Promise<never>((_resolve, reject) => {
                        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                    }),
                ]);
            },
        },
        connectAgent: true,
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await created.queryElementByTestId(dataTestId.messageComposer);

    await sendPrompt(created, composer as HTMLTextAreaElement, "Start a long task");
    await Promise.race([
        created.queryElementByTestId(
            dataTestId.agentResponse,
            (element) => element.textContent?.includes("Before steering.") === true,
        ),
        failure,
    ]);
    const viewer = await created.openViewer();
    await viewer.queryElementByTestId(dataTestId.sessionStatus);
    const activeComposer = await created.queryElementByTestId(dataTestId.messageComposer);
    await created.user.click(activeComposer);
    await created.user.type(activeComposer, "Use the revised requirement");
    await created.user.click(
        await created.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Send message",
        ),
    );
    await created.queryElementByTestId(dataTestId.queuedMessage);
    await viewer.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes("Use the revised requirement") === true,
    );
    viewer.reload();
    await viewer.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes("Use the revised requirement") === true,
    );
    const remoteQueue = await viewer.queryElementByTestId(dataTestId.queuedMessage);
    await viewer.user.click(getByLabelText(remoteQueue, "Delete queued message: Use the revised requirement"));
    await vi.waitFor(() => {
        expect(created.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull();
        expect(viewer.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull();
    });
    await sendPrompt(
        created,
        (await created.queryElementByTestId(dataTestId.messageComposer)) as HTMLTextAreaElement,
        "Use the revised requirement",
    );
    await viewer.queryElementByTestId(dataTestId.queuedMessage);
    await viewer.close();
    await created.user.click(await created.queryElementByTestId(dataTestId.newConversation));
    const workingConversation = await vi.waitFor(() => {
        const conversation = created
            .elementsByTestId(dataTestId.managedConversation)
            .find((candidate) => candidate.textContent?.includes("Start a long task") === true);
        if (conversation === undefined) {
            throw new Error(`The working conversation is unavailable: ${document.body.textContent}`);
        }
        return conversation;
    });
    await created.user.click(workingConversation);

    await created.queryElementByTestId(dataTestId.sessionStatus);
    const restoredQueue = await created.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes("Use the revised requirement") === true,
    );
    await created.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => !(element as HTMLTextAreaElement).disabled,
    );
    expect(created.optionalElementByTestId(dataTestId.agentReplyStatus)).toBeNull();
    await created.user.click(getByLabelText(restoredQueue, "Steer queued message: Use the revised requirement"));
    const steeringMessage = await vi.waitFor(
        () => {
            const message = created
                .elementsByTestId(dataTestId.userMessage)
                .find((element) => element.textContent?.includes("Use the revised requirement") === true);
            if (message === undefined) {
                throw new Error(`The steering message is unavailable: ${document.body.textContent}`);
            }
            return message;
        },
        { timeout: 12_000 },
    );
    continueReply.resolve();
    const after = await Promise.race([
        vi.waitFor(
            () => {
                const response = created
                    .elementsByTestId(dataTestId.agentResponse)
                    .find((element) => element.textContent?.includes("After steering.") === true);
                if (response === undefined) {
                    throw new Error(`The steered response is unavailable: ${document.body.textContent}`);
                }
                return response;
            },
            { timeout: 12_000 },
        ),
        failure,
    ]);

    expect(steeringMessage.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    finishTurn.resolve();
    await vi.waitFor(() => expect(created.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
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
});

test("Given Codex narrates visible progress, When the activity arrives, Then it appears in the Thinking block", {
    timeout: 30_000,
}, async () => {
    const progress = "Inspecting the repository trust boundary before summarizing it.";
    const releaseTurn = Promise.withResolvers<void>();
    const created = await createTestApp({
        agentBehavior: {
            afterLastDelta: async (_command, signal) => {
                await Promise.race([
                    releaseTurn.promise,
                    new Promise<never>((_resolve, reject) =>
                        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
                    ),
                ]);
            },
            progressText: () => progress,
        },
        connectAgent: true,
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await created.queryElementByTestId(dataTestId.messageComposer);

    await sendPrompt(created, composer as HTMLTextAreaElement, "Analyze the repository");
    const thinking = await Promise.race([
        created.queryElementByTestId(
            dataTestId.agentReasoning,
            (element) => element.textContent?.includes(progress) === true,
        ),
        failure,
    ]);

    expect(thinking.textContent).toContain("Thinking");
    expect(thinking.textContent).toContain(progress);
    releaseTurn.resolve();
});

test("Given an Agent streams reasoning, When narration increments arrive, Then the Thinking block updates before reasoning completes", {
    timeout: 30_000,
}, async () => {
    const releaseReasoning = Promise.withResolvers<void>();
    const created = await createTestApp({
        agentBehavior: {
            afterFirstNarration: async (_command, signal) => {
                await Promise.race([
                    releaseReasoning.promise,
                    new Promise<never>((_resolve, reject) =>
                        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
                    ),
                ]);
            },
            reasoningParts: () => ["Checking the event stream. ", "Rendering each increment immediately."],
            responseParts: () => ["Streaming complete."],
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
        "Analyze the live event stream",
    );
    const thinking = await Promise.race([
        created.queryElementByTestId(
            dataTestId.agentReasoning,
            (element) => element.textContent?.includes("Checking the event stream.") === true,
        ),
        failure,
    ]);
    expect(thinking.textContent).not.toContain("Rendering each increment immediately.");

    releaseReasoning.resolve();
    await vi.waitFor(() => expect(thinking.textContent).toContain("Rendering each increment immediately."));
});

test("Given a tool finishes during an active conversation, When its terminal activity arrives, Then the tool shows as succeeded", {
    timeout: 30_000,
}, async () => {
    const releaseTurn = Promise.withResolvers<void>();
    const created = await createTestApp({
        agentBehavior: {
            afterLastDelta: async (_command, signal) => {
                await Promise.race([
                    releaseTurn.promise,
                    new Promise<never>((_resolve, reject) =>
                        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
                    ),
                ]);
            },
        },
        connectAgent: true,
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await created.queryElementByTestId(dataTestId.messageComposer);

    await sendPrompt(created, composer as HTMLTextAreaElement, "Create an image");
    const tool = await Promise.race([created.queryElementByTestId(dataTestId.agentToolCall), failure]);

    await vi.waitFor(() => expect(getByLabelText(tool, "Tool succeeded")).toBeInstanceOf(SVGElement));
    releaseTurn.resolve();
    await vi.waitFor(() => expect(created.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
});

test("Given an Agent links a local file location, When a user opens it, Then the file path omits the source location", {
    timeout: 30_000,
}, async () => {
    const releaseTurn = Promise.withResolvers<void>();
    const created = await createTestApp({
        agentBehavior: {
            afterLastDelta: async (_command, signal) => {
                await Promise.race([
                    releaseTurn.promise,
                    new Promise<never>((_resolve, reject) =>
                        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
                    ),
                ]);
            },
            responseParts: () => [
                "Open [Generated source](</fake/generated-source.ts:104>)\n\n![QR code](file:///fake/generated-image.png)\n\n![Relative badge](badge.png)\n\n![Nested badge](./images/badge%20two.png)",
            ],
        },
        connectAgent: true,
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await created.queryElementByTestId(dataTestId.messageComposer);

    await sendPrompt(created, composer as HTMLTextAreaElement, "Show the generated local artifacts");
    await Promise.race([created.queryElementByTestId(dataTestId.localFileLink), failure]);
    await vi.waitFor(() =>
        expect(getByRole(document.body, "img", { name: "QR code" }).getAttribute("src")).toMatch(/^blob:/u),
    );
    await vi.waitFor(() => {
        expect(getByRole(document.body, "img", { name: "Relative badge" }).getAttribute("src")).toMatch(/^blob:/u);
        expect(getByRole(document.body, "img", { name: "Nested badge" }).getAttribute("src")).toMatch(/^blob:/u);
    });
    await created.user.click(await created.queryElementByTestId(dataTestId.localFileLink));

    const preview = await created.queryElementByTestId(dataTestId.filePreview);
    expect(preview.textContent).not.toContain(":104");
    const content = await created.queryElementByTestId(dataTestId.filePreviewContent);
    expect(content.textContent).toContain("export const generated = true;");
    releaseTurn.resolve();
});

test("Given a Bot has a recent directory from another harness, When its workspace loads, Then the directory remains available", {
    timeout: 30_000,
}, async () => {
    const created = await createTestApp({
        connectAgent: true,
        prepare: (current) =>
            window.localStorage.setItem(
                `mobius:recent-cwd:${encodeURIComponent(current.botId)}`,
                JSON.stringify([{ directoryId: "saved-directory", directoryLabel: "/saved-by-another-harness" }]),
            ),
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));

    const menu = await Promise.race([
        (async () => {
            const workingDirectory = await created.queryElementByTestId(dataTestId.workingDirectory);
            await created.user.click(workingDirectory);
            return await created.queryElementByTestId(
                dataTestId.recentWorkingDirectory,
                (element) => element.textContent?.includes("/saved-by-another-harness") === true,
            );
        })(),
        failure,
    ]);

    expect(menu.textContent).toContain("/saved-by-another-harness");
});
