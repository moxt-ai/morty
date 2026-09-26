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
