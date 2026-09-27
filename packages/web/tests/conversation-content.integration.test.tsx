import { expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given the controlled harness emits reasoning, a tool, and text, When the real daemon streams and restores the turn, Then the complete content remains visible", {
    timeout: 30_000,
}, async () => {
    const prompt = "Inspect the repository";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    const thinking = await vi.waitFor(() => {
        const match = app
            .elementsByTestId(dataTestId.agentReasoning)
            .find((element) => element.textContent?.includes("Inspecting the workspace") === true);
        if (match === undefined) {
            throw new Error(`Reasoning is unavailable: ${document.body.textContent}`);
        }
        return match;
    });
    expect(thinking.textContent).toContain("Thinking");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Read package metadata"));
    await vi.waitFor(() => {
        const restored = app
            .elementsByTestId(dataTestId.agentResponse)
            .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true);
        if (!restored) {
            throw new Error(`The restored response is unavailable: ${document.body.textContent}`);
        }
    });
    await vi.waitFor(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    app.reload();
    await vi.waitFor(() => {
        const restored = app
            .elementsByTestId(dataTestId.agentResponse)
            .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true);
        if (!restored) {
            throw new Error(`The restored response is unavailable: ${document.body.textContent}`);
        }
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("Read package metadata"));
});
