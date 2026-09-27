import { getByLabelText, getByRole } from "@testing-library/dom";
import { expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

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

test("Given an Agent retries after a mid-flight error, When the turn remains active, Then the user sees the recoverable error", {
    timeout: 30_000,
}, async () => {
    const releaseTurn = Promise.withResolvers<void>();
    const created = await createTestApp({
        agentBehavior: {
            noticeText: () => "API error: overloaded. Retrying (attempt 2/5).",
            responseParts: () => ["Recovery succeeded."],
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

    await sendPrompt(
        created,
        (await created.queryElementByTestId(dataTestId.messageComposer)) as HTMLTextAreaElement,
        "Keep working after a provider error",
    );

    const notice = await Promise.race([created.queryElementByTestId(dataTestId.agentNotice), failure]);
    expect(notice.textContent).toContain("API error: overloaded. Retrying (attempt 2/5).");
    expect(created.elementByTestId(dataTestId.sessionStatus)).toBeInstanceOf(HTMLElement);
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

test("Given an Agent emits text, a tool, then text, When the timeline streams and is reopened, Then that order remains visible", {
    timeout: 30_000,
}, async () => {
    const prompt = "Inspect the timeline order";
    const before = "I’ll inspect the workspace before reading the file.";
    const after = "The repository overview is ready.";
    const tool = {
        activityId: "read-between-messages",
        activityType: "tool",
        content: [],
        input: "README.md",
        locations: [],
        name: "read",
        output: "Repository overview",
        sequence: 0,
        status: "completed",
        title: "Read repository overview",
        toolKind: "read",
    };
    let completed = false;
    const created = await createTestApp({
        agentBehavior: {
            activityAfterFirstDelta: () => tool,
            loadNativeHistory: async (_sessionId, signal) => {
                signal.throwIfAborted();
                return {
                    coveredCommandIds: [],
                    coveredMessageIds: [],
                    messages: completed
                        ? [
                              { role: "user", text: prompt },
                              {
                                  activities: [],
                                  content: [],
                                  role: "assistant",
                                  text: before,
                              },
                              {
                                  activities: [tool],
                                  content: [],
                                  role: "assistant",
                                  text: "",
                              },
                              {
                                  activities: [],
                                  content: [],
                                  role: "assistant",
                                  text: after,
                              },
                          ]
                        : [],
                    status: "available",
                    truncated: false,
                };
            },
            onPromptCompleted: () => {
                completed = true;
            },
            responseParts: () => [before, after],
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
    const assertTimelineOrder = async (phase: "reopened" | "streaming"): Promise<void> => {
        await vi.waitFor(() => {
            const responses = created.elementsByTestId(dataTestId.agentResponse);
            const beforeIndex = responses.findIndex((element) => element.textContent?.includes(before) === true);
            const toolCall = created.optionalElementByTestId(dataTestId.agentToolCall);
            const toolIndex = responses.findIndex((element) => toolCall !== null && element.contains(toolCall));
            const afterIndex = responses.findIndex((element) => element.textContent?.includes(after) === true);
            expect(beforeIndex, `${phase} leading text`).toBeGreaterThanOrEqual(0);
            expect(toolIndex, `${phase} tool`).toBeGreaterThan(beforeIndex);
            expect(afterIndex, `${phase} trailing text`).toBeGreaterThan(toolIndex);
        });
    };
    await Promise.race([assertTimelineOrder("streaming"), failure]);
    await vi.waitFor(() => expect(created.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await created.user.click(await created.queryElementByTestId(dataTestId.newConversation));
    const conversation = await vi.waitFor(() => {
        const candidate = created
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => element.textContent?.includes(prompt) === true);
        if (candidate === undefined) {
            throw new Error(`The completed conversation is unavailable: ${document.body.textContent}`);
        }
        return candidate;
    });
    await created.user.click(conversation);
    await assertTimelineOrder("reopened");
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

test("Given a running tool, When the user cancels its turn without a terminal tool event, Then reopening preserves cancellation and later turns remain usable", {
    timeout: 30_000,
}, async () => {
    let cancelled = false;
    const app = await createTestApp({
        connectAgent: true,
        agentBehavior: {
            toolExecution: "wait-for-cancel",
            onPromptCancelled: () => {
                cancelled = true;
            },
            loadNativeHistory: async (_sessionId, signal) => {
                signal.throwIfAborted();
                return {
                    status: "available",
                    coveredCommandIds: [],
                    coveredMessageIds: [],
                    truncated: false,
                    messages: cancelled
                        ? [
                              { role: "user", text: "Create an image" },
                              { role: "assistant", text: "", activities: [], content: [], outcome: "cancelled" },
                          ]
                        : [],
                };
            },
        },
    });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected message composer");
    }
    await sendPrompt(app, composer, "Create an image");
    const tool = await app.queryElementByTestId(dataTestId.agentToolCall);
    await vi.waitFor(() => expect(getByLabelText(tool, "Tool running")).toBeInstanceOf(SVGElement));
    const stop = await app.queryElementByTestId(
        dataTestId.sendMessage,
        (element) =>
            element instanceof HTMLButtonElement &&
            !element.disabled &&
            element.getAttribute("aria-label") === "Stop agent output",
    );
    await app.user.click(stop);
    await vi.waitFor(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await vi.waitFor(() => expect(getByLabelText(tool, "Tool interrupted")).toBeInstanceOf(SVGElement));
    app.reload();
    const status = await app.queryElementByTestId(dataTestId.agentReplyStatus);
    expect(status.textContent).toBe("Response cancelled.");
    expect(document.body.textContent).not.toContain("Agent finished without a text response.");
    const continuedComposer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(continuedComposer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected active session composer");
    }
    await sendPrompt(app, continuedComposer, "Continue after cancellation");
    await vi.waitFor(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Continue after cancellation") === true),
        ).toBe(true),
    );
    await vi.waitFor(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
});
