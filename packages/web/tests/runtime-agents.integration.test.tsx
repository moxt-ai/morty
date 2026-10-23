import { getByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

// The Worker checks the Runtime every 5 s and retries a failed check 5 s later, so one change can take two checks.
const RUNTIME_CHANGE_TIMEOUT_MS = 20_000;

async function openAgentConfiguration(app: TestApp): Promise<HTMLElement> {
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    return getByRole(document.body, "dialog", { name: "Agent configuration" });
}

test("Given an open conversation, When its Agent is renamed on the computer, Then the conversation shows the new name without a reload", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({ agents: [{ id: "codex", label: "Codex" }], connectAgent: true });
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

    // The conversation's own menu names the harness the way the computer now does.
    const after = await openAgentConfiguration(app);
    await app.waitForView(
        () => expect(getByRole(after, "heading", { name: "Codex Pro" })).toBeDefined(),
        RUNTIME_CHANGE_TIMEOUT_MS,
    );
});
