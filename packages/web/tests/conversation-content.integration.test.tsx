import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given the daemon emits reasoning, a tool, and text, When the user observes and stops an unfinished turn, Then partial content is visible before completion and survives remount", {
    timeout: 30_000,
}, async () => {
    const prompt = "hold with rich content";
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
    const thinking = await app.waitForView(() => {
        const match = app
            .elementsByTestId(dataTestId.agentReasoning)
            .find((element) => element.textContent?.includes("Inspecting the workspace") === true);
        if (match === undefined) {
            throw new Error(`Reasoning is unavailable: ${document.body.textContent}`);
        }
        return match;
    });
    expect(thinking.textContent).toContain("Thinking");
    await app.waitForView(() => expect(document.body.textContent).toContain("Read package metadata"));
    await app.waitForView(() => {
        const restored = app
            .elementsByTestId(dataTestId.agentResponse)
            .some((element) => element.textContent?.includes("Partial rich reply") === true);
        if (!restored) {
            throw new Error(`The restored response is unavailable: ${document.body.textContent}`);
        }
    });
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    app.remount();
    await app.waitForView(() => {
        const restored = app
            .elementsByTestId(dataTestId.agentResponse)
            .some((element) => element.textContent?.includes("Partial rich reply") === true);
        if (!restored) {
            throw new Error(`The restored response is unavailable: ${document.body.textContent}`);
        }
    });
    await app.waitForView(() => expect(document.body.textContent).toContain("Read package metadata"));
});
