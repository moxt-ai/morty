import { getByLabelText } from "@testing-library/dom";
import { expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

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
        finishSecond.resolve();
        for (const current of [app, viewer]) {
            await current.queryElementByTestId(
                dataTestId.sendMessage,
                (element) => element.getAttribute("aria-label") === "Send message",
            );
            expect(
                current.elementsByTestId(dataTestId.agentReplyStatus).map((element) => element.textContent),
            ).not.toContain("Agent updates stopped. Check your local agent or reconnect.");
        }
    } finally {
        finishFirst.resolve();
        finishSecond.resolve();
    }
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
