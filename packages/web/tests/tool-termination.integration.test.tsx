import { getAllByLabelText, getByLabelText, getByRole, queryByLabelText } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

function readTool(app: TestApp, title: string) {
    const entry = app
        .elementsByTestId(dataTestId.agentToolCall)
        .find((element) => element.getAttribute("aria-label") === `Tool: ${title}`);
    if (entry === undefined) {
        throw new Error(`Tool unavailable: ${title}`);
    }
    return entry;
}
async function tool(app: TestApp, title: string) {
    return await app.waitForView(() => readTool(app, title));
}
async function assertSettled(app: TestApp) {
    for (const title of ["Unfinished verification", "Pending verification"]) {
        await app.waitForView(() => expect(getByLabelText(readTool(app, title), "Tool interrupted")).toBeDefined());
        expect(queryByLabelText(readTool(app, title), "Tool running")).toBeNull();
    }
    expect(getByLabelText(await tool(app, "Completed verification"), "Tool succeeded")).toBeDefined();
    expect(getByLabelText(await tool(app, "Failed verification"), "Tool failed")).toBeDefined();
}
async function start(prompt: string) {
    const app = await createTestApp({
        connectAgent: true,
        agent: { id: "tool-lifecycle-test", label: "Tool Lifecycle Agent" },
        page: { kind: "bootstrap", identity: true },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), prompt);
    return app;
}

for (const prompt of ["fail unfinished tools", "complete unfinished tools"]) {
    test(`Given unfinished tools, When the agent returns ${prompt}, Then terminal tool outcomes are preserved and unfinished tools become interrupted`, {
        timeout: 30_000,
    }, async () => {
        const app = await start(prompt);
        await assertSettled(app);
        const reloaded = await app.reload();
        await assertSettled(reloaded);
        await sendPrompt(
            reloaded,
            await reloaded.queryElementByTestId(dataTestId.messageComposer),
            "hold unfinished tools",
        );
        await reloaded.waitForView(() => expect(getAllByLabelText(document.body, "Tool running")).toHaveLength(2));
        expect(getAllByLabelText(document.body, "Tool interrupted")).toHaveLength(2);
        await reloaded.user.click(
            await reloaded.queryElementByTestId(
                dataTestId.sendMessage,
                (element) => element.getAttribute("aria-label") === "Stop agent output",
            ),
        );
        await reloaded.waitForView(() => expect(getAllByLabelText(document.body, "Tool interrupted")).toHaveLength(4));
    });
}

for (const prompt of ["hold unfinished tools", "hold steering acknowledgement"]) {
    test(`Given a running turn receives steering during ${prompt}, When the user stops the original turn, Then tools created by the steered work are interrupted for every viewer`, {
        timeout: 30_000,
    }, async () => {
        const app = await start(prompt);
        await tool(app, "Pending verification");
        const viewer = await app.openViewer();
        await tool(viewer, "Pending verification");
        const instruction = "Add another verification";
        await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), instruction);
        const queued = await app.queryElementByTestId(
            dataTestId.queuedMessage,
            (element) => element.textContent?.includes(instruction) === true,
        );
        await app.user.click(getByLabelText(queued, `Steer queued message: ${instruction}`));
        await tool(app, "Steered verification");
        if (prompt === "hold unfinished tools") {
            await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull());
        }
        await app.user.click(
            await app.queryElementByTestId(
                dataTestId.sendMessage,
                (element) => element.getAttribute("aria-label") === "Stop agent output",
            ),
        );
        for (const current of [app, viewer]) {
            await assertSettled(current);
            await current.waitForView(() =>
                expect(getByLabelText(readTool(current, "Steered verification"), "Tool interrupted")).toBeDefined(),
            );
        }
        await viewer.close();
        const reloaded = await app.reload();
        await reloaded.waitForView(() =>
            expect(getByLabelText(readTool(reloaded, "Steered verification"), "Tool interrupted")).toBeDefined(),
        );
    });
}

test("Given an idle conversation is being opened by another viewer, When a new turn starts, Then its tools remain running in both viewers until stopped", {
    timeout: 30_000,
}, async () => {
    const app = await start("complete unfinished tools");
    await assertSettled(app);
    const viewer = await app.openViewer();
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "hold unfinished tools");
    for (const current of [app, viewer]) {
        await current.waitForView(() => expect(current.elementsByTestId(dataTestId.agentToolCall)).toHaveLength(8));
        const unfinished = current
            .elementsByTestId(dataTestId.agentToolCall)
            .filter((entry) => entry.getAttribute("aria-label") === "Tool: Unfinished verification");
        const activeTool = unfinished[1];
        if (activeTool === undefined) {
            throw new Error("Missing the new turn's tool");
        }
        expect(getByLabelText(activeTool, "Tool running")).toBeDefined();
    }
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );
    for (const current of [app, viewer]) {
        await current.waitForView(() =>
            expect(
                current
                    .elementsByTestId(dataTestId.agentToolCall)
                    .filter((entry) => queryByLabelText(entry, "Tool interrupted") !== null),
            ).toHaveLength(4),
        );
    }
    await viewer.close();
});

test("Given another viewer opens a history page beginning with steering already in progress, When the original execution stops, Then all visible steered tools are interrupted without loading older messages", {
    timeout: 30_000,
}, async () => {
    const app = await start("hold paginated steering");
    await tool(app, "Pending verification");
    const instruction = "Add verification tools";
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), instruction);
    const queued = await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(instruction) === true,
    );
    await app.user.click(getByLabelText(queued, `Steer queued message: ${instruction}`));
    await tool(app, "Steered verification 32");
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull());
    const viewer = await app.openViewer();
    await tool(viewer, "Steered verification 32");
    // Enough visible tools fill the latest history page without the steering request.
    expect(viewer.elementsByTestId(dataTestId.agentToolCall)).toHaveLength(30);
    expect(getByLabelText(await tool(viewer, "Steered verification 3"), "Tool running")).toBeDefined();
    expect(viewer.elementsByTestId(dataTestId.userMessage).some((message) => message.textContent === instruction)).toBe(
        false,
    );
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );
    await viewer.waitForView(() =>
        expect(
            viewer
                .elementsByTestId(dataTestId.agentToolCall)
                .filter((entry) => queryByLabelText(entry, "Tool interrupted") !== null),
        ).toHaveLength(30),
    );
    await viewer.close();
});

for (const [reason, notice] of [
    ["max_tokens", "The response reached its length limit."],
    ["max_turn_requests", "The agent reached its request limit for this turn."],
    ["refusal", "The agent declined this request."],
] as const) {
    test(`Given a turn ends with ${reason}, When I view it and reload, Then the reason is live-only and its tools stay settled`, {
        timeout: 30_000,
    }, async () => {
        const app = await start(`stop with ${reason}`);
        await assertSettled(app);
        expect((await app.queryElementByTestId(dataTestId.agentReplyStatus)).textContent).toBe(notice);
        const reloaded = await app.reload();
        await assertSettled(reloaded);
        expect(reloaded.optionalElementByTestId(dataTestId.agentReplyStatus)).toBeNull();
    });
}

for (const [status, label] of [
    ["completed", "Completed"],
    ["failed", "Failed"],
    ["stopped", "Stopped"],
    ["unknown", "Status unknown"],
]) {
    test(`Given a background task outlives its reply, When its ${status} notification arrives, Then its original card updates without an extra user message`, {
        timeout: 30_000,
    }, async () => {
        const app = await start("start background verification");
        const summary = await app.waitForView(() =>
            getByRole(document.body, "button", { name: "1 step · 1 running in background" }),
        );
        await app.user.click(summary);
        await app.waitForView(() =>
            expect(readTool(app, "Background verification").textContent).toContain("Running in background"),
        );
        expect(queryByLabelText(await tool(app, "Background verification"), "Tool succeeded")).toBeNull();
        await sendPrompt(
            app,
            await app.queryElementByTestId(dataTestId.messageComposer),
            `finish background verification ${status}`,
        );
        await app.waitForView(() => expect(readTool(app, "Background verification").textContent).toContain(label));
        expect(app.elementsByTestId(dataTestId.agentToolCall)).toHaveLength(1);
        const reloaded = await app.reload();
        const restoredSummary = await reloaded.waitForView(() =>
            getByRole(document.body, "button", { name: /^1 step/ }),
        );
        const summarySuffix =
            status === "failed"
                ? " · 1 failed"
                : status === "stopped"
                  ? " · 1 interrupted"
                  : status === "unknown"
                    ? " · 1 status unknown"
                    : "";
        expect(restoredSummary.textContent).toBe(`1 step${summarySuffix}`);
        await reloaded.user.click(restoredSummary);
        await reloaded.waitForView(() =>
            expect(readTool(reloaded, "Background verification").textContent).toContain(label),
        );
        expect(reloaded.elementsByTestId(dataTestId.agentToolCall)).toHaveLength(1);
    });
}
