import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given an Agent compacts the conversation context, When the user reads the timeline, Then Chat shows a compaction disclosure with the retained summary", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "compact the conversation");

    await app.waitForView(() => {
        const compaction = app.elementByTestId(dataTestId.agentCompaction);
        expect(compaction.textContent).toContain("Context compaction completed");
        const summary = compaction.querySelector("pre");
        expect(summary?.textContent).toContain("The user explored the session timeline.");
        expect(summary?.textContent).toContain("Context was summarized.");
    });
    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toBe(
            "Context compacted; continuing with the summary.",
        ),
    );
});
