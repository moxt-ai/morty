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

test("Given a running tool, When the user cancels its turn without a terminal tool event, Then the tool is interrupted and later turns remain usable", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, agentBehavior: { toolExecution: "wait-for-cancel" } });
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
    await app.user.click(getByRole(document.body, "button", { name: "Stop agent output" }));
    await vi.waitFor(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await vi.waitFor(() => expect(getByLabelText(tool, "Tool interrupted")).toBeInstanceOf(SVGElement));
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
