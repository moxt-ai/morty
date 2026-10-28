import { getByRole, getByText, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given consecutive tool calls, When I expand their summary with the keyboard, Then every call is available and my choice survives further calls and completion", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a controlled Agent Runtime");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.waitForView(() => getByText(document.body, "Waiting for steering"));
    await daemon.continueReply("wait for steering", {
        outcome: "hold",
        output: [
            {
                kind: "activity",
                activityType: "tool",
                title: "Read package metadata",
                content: [],
                output: "Package metadata",
            },
            {
                kind: "activity",
                activityType: "tool",
                title: "Inspect test scripts",
                content: [],
                output: "Test scripts",
            },
        ],
    });
    const execution = await app.waitForView(() => getByRole(document.body, "group", { name: "Execution details" }));
    const summary = getByRole(execution, "button", { name: "Show execution details" });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(queryByRole(execution, "group", { name: "Tool: Read package metadata" })).toBeNull();
    expect(queryByRole(execution, "group", { name: "Tool: Inspect test scripts" })).toBeNull();
    await app.user.click(summary);
    await app.user.keyboard("{Enter}");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    await app.user.keyboard(" ");
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(getByRole(execution, "group", { name: "Tool: Read package metadata" })).toBeDefined();
    expect(getByRole(execution, "group", { name: "Tool: Inspect test scripts" })).toBeDefined();
    await daemon.continueReply("wait for steering", {
        outcome: "hold",
        output: [
            {
                kind: "activity",
                activityType: "tool",
                title: "Check the changes",
                content: [],
                output: "Changes verified",
            },
        ],
    });
    await app.waitForView(() => getByRole(execution, "group", { name: "Tool: Check the changes" }));
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    await daemon.continueReply("wait for steering", {
        outcome: "complete",
        output: [{ kind: "text", text: "The changes are ready for review." }],
    });
    await app.waitForView(() => getByText(document.body, "The changes are ready for review."));
    expect(summary.isConnected).toBe(true);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    const check = getByRole(execution, "group", { name: "Tool: Check the changes" });
    await app.user.click(getByRole(check, "button"));
    expect(getByText(check, "Changes verified")).toBeDefined();
    await app.user.click(summary);
    expect(queryByRole(execution, "group", { name: "Tool: Check the changes" })).toBeNull();
    expect(getByText(document.body, "The changes are ready for review.")).toBeDefined();
});

test("Given a failed tool followed by a final answer, When the execution is collapsed, Then its failure remains visible without opening the call history", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { id: "tool-lifecycle-test", label: "Tool Lifecycle Agent" },
        page: { kind: "bootstrap", identity: true },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "answer after verification");
    await app.waitForView(() => getByText(document.body, "Verification finished with one failure."));
    expect(getByRole(document.body, "group", { name: "Tool: Failed verification" })).toBeDefined();
    expect(queryByRole(document.body, "group", { name: "Tool: Completed verification" })).toBeNull();
    expect(getByText(document.body, "Checking the failed verification.")).toBeDefined();
    expect(getByText(document.body, "Verification command exited with status 1.")).toBeDefined();
});

for (const [prompt, phase] of [
    ["hold categorized execution", "Reading files"],
    ["hold uncategorized execution", "Running tools"],
    ["hold parallel execution", "Running 2 tools"],
] as const) {
    test(`Given ${prompt}, When a partial update arrives without a category, Then the summary shows ${phase} and details remain available`, {
        timeout: 30_000,
    }, async () => {
        const app = await createTestApp({
            connectAgent: true,
            agent: { id: "tool-lifecycle-test", label: "Tool Lifecycle Agent" },
            page: { kind: "bootstrap", identity: true },
        });
        await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), prompt);
        const history = await app.waitForView(() => getByRole(document.body, "group", { name: "Execution details" }));
        await app.waitForView(() => expect(getByText(history, phase)).toBeDefined());
        await app.user.click(getByRole(history, "button", { name: "Show execution details" }));
        const tool = getByRole(history, "group", { name: "Tool: Inspect package metadata" });
        await app.user.click(getByRole(tool, "button"));
        await app.waitForView(() => expect(getByText(tool, "Received partial package metadata")).toBeDefined());
        expect(getByText(history, phase)).toBeDefined();
        await app.user.click(getByRole(document.body, "button", { name: "Stop agent output" }));
        await app.waitForView(() => expect(getByText(history, "Execution interrupted")).toBeDefined());
        expect(getByRole(history, "button", { name: "Hide execution details" }).getAttribute("aria-expanded")).toBe(
            "true",
        );
    });
}

test("Given collapsed execution history, When permission and a question are requested, Then both decisions remain visible and usable without expanding history", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { id: "interaction-test", label: "Interaction Agent" },
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "request after execution");
    const permission = await app.waitForView(() =>
        getByRole(document.body, "alertdialog", { name: "Agent permission request" }),
    );
    const summary = getByRole(document.body, "button", { name: "Show execution details" });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(summary.textContent).toContain("Waiting for confirmation");
    expect(queryByRole(document.body, "status", { name: "Agent is working" })).toBeNull();
    expect(queryByRole(document.body, "group", { name: "Tool: Read verification configuration" })).toBeNull();
    await app.user.click(getByRole(permission, "button", { name: "Allow: Yes" }));
    const form = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Agent information request" }));
    await app.user.type(getByRole(form, "textbox", { name: "Branch" }), "feature/summary");
    await app.user.click(getByRole(form, "button", { name: "Continue" }));
    await app.waitForView(() => expect(getByText(document.body, "Selected branch: feature/summary")).toBeDefined());
    expect(summary.getAttribute("aria-expanded")).toBe("false");
});
