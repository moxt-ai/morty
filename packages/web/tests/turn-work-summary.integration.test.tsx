import {
    getAllByRole,
    getByLabelText,
    getByRole,
    getByText,
    queryByLabelText,
    queryByRole,
} from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

const workSummary = "2 steps · 1 file edit";
const failureSummary = "1 step · 1 failed";

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
    return await app.waitForView(() => {
        const work = getByRole(document.body, "button", { name: workSummary, expanded: false });
        const failure = getByRole(document.body, "button", { name: failureSummary, expanded: false });
        expect(getByText(document.body, "Checking the failed verification.")).toBeDefined();
        expect(getByText(document.body, "Verification finished with one failure.")).toBeDefined();
        expect(queryByLabelText(document.body, "Tool: Failed verification")).toBeNull();
        return { failure, work };
    });
}

test("Given the agent works through tools before answering, When the turn completes, Then each process segment collapses into a summary and the answer stays visible", {
    timeout: 30_000,
}, async () => {
    const app = await start("answer after verification");
    const { work, failure } = await assertWorkCollapsed(app);

    await app.user.click(work);
    await app.user.click(failure);

    expect(work.getAttribute("aria-expanded")).toBe("true");
    expect(failure.getAttribute("aria-expanded")).toBe("true");
    for (const label of ["Tool: Completed verification", "Edit: Update notes", "Tool: Failed verification"]) {
        expect(queryByLabelText(document.body, label)).not.toBeNull();
    }
    expect(getByText(document.body, "Verification finished with one failure.")).toBeDefined();

    const reloaded = await app.reload();
    await assertWorkCollapsed(reloaded);
});

test("Given the agent has answered part of a turn, When the user stops it, Then the stopped turn keeps its work behind a summary", {
    timeout: 30_000,
}, async () => {
    const app = await start("answer then hold");
    await app.waitForView(() => getByText(document.body, "Partial answer before stopping."));

    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );

    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentReplyStatus).textContent).toBe("Turn stopped."),
    );
    const summary = getByRole(document.body, "button", { name: "1 step", expanded: false });
    await app.user.click(summary);
    await app.waitForView(() => expect(queryByLabelText(document.body, "Tool: Completed verification")).not.toBeNull());
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
    const stoppedSummary = getByRole(document.body, "button", { name: "1 step", expanded: false });
    await app.user.click(stoppedSummary);
    await app.waitForView(() => expect(queryByLabelText(document.body, "Tool: Completed verification")).not.toBeNull());
});

test("Given the agent has answered part of a turn, When the user steers it and then stops it, Then the steered execution keeps its earlier work behind summaries", {
    timeout: 30_000,
}, async () => {
    const app = await start("answer then hold");
    await app.waitForView(() => getByText(document.body, "Partial answer before stopping."));
    const instruction = "Also check the notes";
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), instruction);
    const queued = await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(instruction) === true,
    );

    await app.user.click(getByLabelText(queued, `Steer queued message: ${instruction}`));

    const steered = await app.waitForView(() => {
        const summaries = getAllByRole(document.body, "button", { name: "1 step", expanded: false });
        expect(summaries).toHaveLength(2);
        const latest = summaries.at(-1);
        if (latest === undefined) {
            throw new Error("Expected the steered process summary");
        }
        return latest;
    });
    expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toContain(instruction);
    await app.user.click(steered);
    await app.waitForView(() => expect(queryByLabelText(document.body, "Tool: Steered verification")).not.toBeNull());

    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );

    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentReplyStatus).textContent).toBe("Turn stopped."),
    );
    expect(queryByLabelText(document.body, "Tool: Steered verification")).not.toBeNull();
    expect(queryByRole(document.body, "button", { name: "1 step · 1 interrupted", expanded: true })).not.toBeNull();
});
