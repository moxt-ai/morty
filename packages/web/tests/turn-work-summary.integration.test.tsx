import { getByRole, getByText, queryByLabelText, queryByRole, queryByText } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

const workSummary = "3 steps · 1 file edit · 1 failed";

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
    const summary = await app.waitForView(() => getByRole(document.body, "button", { name: workSummary }));
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(getByText(document.body, "Verification finished with one failure.")).toBeDefined();
    expect(queryByText(document.body, "Checking the failed verification.")).toBeNull();
    expect(queryByLabelText(document.body, "Tool: Failed verification")).toBeNull();
    return summary;
}

test("Given the agent works through tools before answering, When the turn completes, Then its work collapses into a summary and the final answer stays visible", {
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

test("Given the agent has answered part of a turn, When the user stops it, Then the stopped turn keeps its work visible", {
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
    expect(queryByLabelText(document.body, "Tool: Completed verification")).not.toBeNull();
    expect(queryByRole(document.body, "button", { name: /^1 step/ })).toBeNull();
});
