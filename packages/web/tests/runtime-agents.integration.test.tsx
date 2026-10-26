import { getByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { openExecutionDetails, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

const CLOCK_ORIGIN = "2026-10-13T08:00:00Z";

async function openAgentConfiguration(app: TestApp): Promise<HTMLElement> {
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    return getByRole(document.body, "dialog", { name: "Agent configuration" });
}

test("Given an open conversation, When its Agent is renamed on the computer, Then the conversation shows the new name without a reload", {
    timeout: 60_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ agents: [{ id: "codex", label: "Codex" }], connectAgent: true, clock });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    const draft = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    await sendPrompt(app, draft, "Work on Codex");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Work on Codex")),
        ).toBe(true),
    );
    const before = await openAgentConfiguration(app);
    await app.waitForView(() => expect(getByRole(before, "heading", { name: "Codex" })).toBeDefined());
    await app.user.keyboard("{Escape}");

    await daemon.replaceAgents([{ id: "codex", label: "Codex Pro" }]);
    // The page hears the Runtime's current configuration when its Chat connection returns, without waiting for the
    // Worker's periodic check: the recovered watch starts from that configuration.
    app.transport.disconnect();
    await act(async () => {
        clock.advanceBy(1_000);
    });

    // The conversation's own menu names the harness the way the computer now does.
    const after = await openAgentConfiguration(app);
    await app.waitForView(() => expect(getByRole(after, "heading", { name: "Codex Pro" })).toBeDefined());
});

test("Given a new conversation draft, When its Agent is renamed on the computer, Then the draft's execution details name it the way the computer now does", {
    timeout: 60_000,
}, async () => {
    const clock = new TestClock(CLOCK_ORIGIN);
    const app = await createTestApp({ agents: [{ id: "codex", label: "Codex" }], connectAgent: true, clock });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    const details = await openExecutionDetails(app);
    // The draft names its agent once its settings load.
    await app.waitForView(() => expect(details.textContent).toContain("Codex"));
    expect(details.textContent).not.toContain("Codex Pro");

    await daemon.replaceAgents([{ id: "codex", label: "Codex Pro" }]);
    app.transport.disconnect();
    await act(async () => {
        clock.advanceBy(1_000);
    });

    // The open details follow the Runtime configuration the page follows.
    await app.waitForView(() => expect(details.textContent).toContain("Codex Pro"));
});
