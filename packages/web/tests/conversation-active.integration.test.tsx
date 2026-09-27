import { expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

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
    expect(document.body.textContent).not.toContain("No message history is available for this conversation.");
    expect(created.elementsByTestId(dataTestId.userMessage)).toHaveLength(0);
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

test("Given a conversation is working, When the user reopens it, Then its daemon snapshot restores live status and replaces stale native output", {
    timeout: 30_000,
}, async () => {
    const releaseTurn = Promise.withResolvers<void>();
    const releaseSnapshot = Promise.withResolvers<void>();
    let turnStarted = false;
    let activeCommandId: string | null = null;
    const prompt = "Keep this session working while I leave";
    const answer = "The active response remains visible.";
    const progress = "Inspecting the active workspace once.";
    const created = await createTestApp({
        agentBehavior: {
            afterSessionStarted: async (command, signal) => {
                signal.throwIfAborted();
                turnStarted = true;
                activeCommandId = command.commandId;
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
                    coveredCommandIds: activeCommandId === null ? [] : [activeCommandId],
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
        vi.waitFor(() =>
            expect(
                created
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((element) => element.textContent?.includes(answer) === true),
            ).toBe(true),
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
        ).toHaveLength(0);
        expect(
            activities.filter((element) => element.textContent?.includes("Create app directory") === true),
        ).toHaveLength(0);
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

test("Given narration is streaming, When another viewer loads history overlapping a live increment, Then both viewers show each increment once", {
    timeout: 30_000,
}, async () => {
    const releaseIncrement = Promise.withResolvers<void>();
    const incrementSent = Promise.withResolvers<void>();
    const releaseCompletion = Promise.withResolvers<void>();
    const first = "Inspecting the workspace. ";
    const second = "Checking the requested files.";
    const prompt = "Inspect without repeating progress";
    let openingViewer = false;
    let activeCommandId: string | null = null;
    let completed = false;
    const wait = async (promise: Promise<void>, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        const aborted = Promise.withResolvers<never>();
        const abort = (): void => aborted.reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        try {
            await Promise.race([promise, aborted.promise]);
        } finally {
            signal.removeEventListener("abort", abort);
        }
    };
    const created = await createTestApp({
        connectAgent: true,
        agentBehavior: {
            afterSessionStarted: async (command, signal) => {
                signal.throwIfAborted();
                activeCommandId = command.commandId;
            },
            onPromptCompleted: () => {
                completed = true;
            },
            reasoningParts: () => [first, second],
            responseParts: () => ["Completed without repeating progress."],
            afterFirstNarration: async (_command, signal) => wait(releaseIncrement.promise, signal),
            afterLastNarration: async (_command, signal) => {
                incrementSent.resolve();
                await wait(releaseCompletion.promise, signal);
            },
            loadNativeHistory: async (_sessionId, signal) => {
                if (openingViewer) {
                    releaseIncrement.resolve();
                    await wait(incrementSent.promise, signal);
                }
                return {
                    status: "available",
                    truncated: false,
                    coveredCommandIds: activeCommandId === null ? [] : [activeCommandId],
                    coveredMessageIds: [],
                    messages: completed
                        ? [
                              { role: "user", text: prompt },
                              {
                                  role: "assistant",
                                  text: "",
                                  content: [],
                                  activities: [
                                      {
                                          activityId: "fake-reasoning-1",
                                          activityType: "reasoning",
                                          content: [],
                                          input: "",
                                          locations: [],
                                          name: "",
                                          output: first + second,
                                          sequence: 0,
                                          status: "completed",
                                          title: "Reasoning",
                                          toolKind: "",
                                      },
                                  ],
                              },
                              {
                                  role: "assistant",
                                  text: "Completed without repeating progress.",
                                  content: [],
                                  activities: [],
                                  outcome: "succeeded",
                              },
                          ]
                        : openingViewer
                          ? [
                                { role: "user", text: prompt },
                                {
                                    role: "assistant",
                                    text: "",
                                    content: [],
                                    activities: [
                                        {
                                            activityId: "fake-reasoning-1",
                                            activityType: "reasoning",
                                            content: [],
                                            input: "",
                                            locations: [],
                                            name: "",
                                            output: first + second,
                                            sequence: 0,
                                            status: "running",
                                            title: "Reasoning",
                                            toolKind: "",
                                        },
                                    ],
                                },
                            ]
                          : [],
                };
            },
        },
    });
    try {
        await created.queryElementByTestId(
            dataTestId.botConnectionStatus,
            (element) => element.textContent?.includes("Connected") === true,
        );
        const composer = await created.queryElementByTestId(dataTestId.messageComposer);
        if (!(composer instanceof HTMLTextAreaElement)) {
            throw new Error("Expected the message composer");
        }
        await sendPrompt(created, composer, prompt);
        await created.queryElementByTestId(
            dataTestId.agentReasoning,
            (element) => element.textContent?.includes(first.trim()) === true,
        );
        openingViewer = true;
        const viewer = await created.openViewer();
        const thinking = await viewer.queryElementByTestId(
            dataTestId.agentReasoning,
            (element) => element.textContent?.includes(second) === true,
        );
        const original = await created.queryElementByTestId(
            dataTestId.agentReasoning,
            (element) => element.textContent?.includes(second) === true,
        );
        expect(thinking.textContent).toBe(original.textContent);
        expect(thinking.textContent?.split(second)).toHaveLength(2);
        releaseCompletion.resolve();
        for (const app of [created, viewer]) {
            await vi.waitFor(() =>
                expect(
                    app
                        .elementsByTestId(dataTestId.agentResponse)
                        .some((element) => element.textContent?.includes("Completed without repeating progress.")),
                ).toBe(true),
            );
            expect(app.elementByTestId(dataTestId.agentReasoning).textContent?.split(second)).toHaveLength(2);
        }
    } finally {
        releaseIncrement.resolve();
        releaseCompletion.resolve();
    }
});
