import { getByLabelText, getByRole, getByText, queryByLabelText, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { expandExecutionHistory, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

const workSummary = "Show execution details";

async function start(prompt: string) {
    const app = await createTestApp({
        connectAgent: true,
        agent: { id: "tool-lifecycle-test", label: "Tool Lifecycle Agent" },
        page: { kind: "bootstrap", identity: true },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), prompt);
    return app;
}

async function assertWorkCollapsed(app: TestApp) {
    await app.waitForView(() => getByText(document.body, "Verification finished with one failure."));
    const summary = await app.waitForView(() => {
        const group = getByText(document.body, "2 steps").closest("fieldset");
        if (!(group instanceof HTMLElement)) {
            throw new Error("Missing the first execution group");
        }
        return getByRole(group, "button", { name: workSummary });
    });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(getByText(document.body, "Verification finished with one failure.")).toBeDefined();
    expect(getByText(document.body, "Checking the failed verification.")).toBeDefined();
    expect(getByLabelText(document.body, "Tool: Failed verification")).toBeDefined();
    return summary;
}

test("Given the agent works through tools before answering, When the turn completes, Then each consecutive run is summarized while progress and failures stay visible", {
    timeout: 30_000,
}, async () => {
    const app = await start("answer after verification");
    const summary = await assertWorkCollapsed(app);

    await app.user.click(summary);

    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(getByText(document.body, "Checking the failed verification.")).toBeDefined();
    for (const label of ["Tool: Completed verification", "Edit: Update notes", "Tool: Failed verification"]) {
        expect(queryByLabelText(document.body, label)).not.toBeNull();
    }
    expect(getByText(document.body, "Verification finished with one failure.")).toBeDefined();

    const reloaded = await app.reload();
    await assertWorkCollapsed(reloaded);
});

test("Given the agent has answered part of a turn, When the user opens its history and stops it, Then the stopped turn keeps that history open", {
    timeout: 30_000,
}, async () => {
    const app = await start("answer then hold");
    await app.waitForView(() => getByText(document.body, "Partial answer before stopping."));
    await expandExecutionHistory(app);

    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );

    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentReplyStatus).textContent).toBe("Turn stopped."),
    );
    expect(queryByLabelText(document.body, "Tool: Completed verification")).not.toBeNull();
    expect(getByRole(document.body, "button", { name: "Hide execution details" }).getAttribute("aria-expanded")).toBe(
        "true",
    );
});

test("Given a reloaded completed reply with tools, When the user starts another turn and stops it, Then the earlier work stays collapsed", {
    timeout: 30_000,
}, async () => {
    const original = await start("answer after verification");
    await assertWorkCollapsed(original);
    const app = await original.reload();
    await assertWorkCollapsed(app);

    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "answer then hold");
    await app.waitForView(() => getByText(document.body, "Partial answer before stopping."));
    await assertWorkCollapsed(app);

    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentReplyStatus).textContent).toBe("Turn stopped."),
    );
    await assertWorkCollapsed(app);
    expect(queryByLabelText(document.body, "Tool: Completed verification")).toBeNull();
});

test("Given the agent has answered part of a turn, When the user steers it and then stops it, Then both execution groups retain the user's expanded choice", {
    timeout: 30_000,
}, async () => {
    const app = await start("answer then hold");
    await app.waitForView(() => getByText(document.body, "Partial answer before stopping."));
    await expandExecutionHistory(app);
    const instruction = "Also check the notes";
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), instruction);
    const queued = await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(instruction) === true,
    );

    await app.user.click(getByLabelText(queued, `Steer queued message: ${instruction}`));

    await app.user.click(
        await app.waitForView(() => getByRole(document.body, "button", { name: "Show execution details" })),
    );
    await app.waitForView(() => expect(queryByLabelText(document.body, "Tool: Steered verification")).not.toBeNull());
    expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toContain(instruction);
    expect(queryByLabelText(document.body, "Tool: Completed verification")).not.toBeNull();
    expect(queryByRole(document.body, "button", { name: "Show execution details" })).toBeNull();

    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );

    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentReplyStatus).textContent).toBe("Turn stopped."),
    );
    expect(queryByLabelText(document.body, "Tool: Completed verification")).not.toBeNull();
    expect(queryByRole(document.body, "button", { name: "Show execution details" })).toBeNull();
});
