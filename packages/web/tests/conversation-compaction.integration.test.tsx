import { queryByRole } from "@testing-library/dom";
import { flushSync } from "react-dom";
import { expect, onTestFinished, test, vi } from "vitest";
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

test("Given an Agent settles a compaction with a multi-block summary, When the user reads the timeline, Then Chat shows every summary text block in order", {
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

    await sendPrompt(app, composer, "compact with summary blocks");

    await app.waitForView(() => {
        const compaction = app.elementByTestId(dataTestId.agentCompaction);
        expect(compaction.textContent).toContain("Context compaction completed");
        const summary = compaction.querySelector("pre");
        expect(summary?.textContent).toContain("Early discussion covered the page merge.");
        expect(summary?.textContent).toContain("Later discussion covered the summary.");
        expect(summary?.textContent?.indexOf("Early discussion")).toBeLessThan(
            summary?.textContent?.indexOf("Later discussion") ?? -1,
        );
    });
});

test("Given a history page that ends mid-compaction, When the user loads older messages, Then the pages merge into one compaction entry with the whole summary", {
    timeout: 90_000,
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

    await sendPrompt(app, composer, "many session events then compact");
    await app.waitForView(() => expect(app.elementsByTestId(dataTestId.agentCompaction).length).toBe(1));
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentCompaction).textContent).toContain("Context compaction completed"),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());

    // Reopen the saved conversation so history loads through the paginated
    // boundary instead of the live stream.
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const conversation = await app.waitForView(() => {
        const candidate = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => element.textContent?.includes("many session events then compact") === true);
        if (candidate === undefined) {
            throw new Error(`The completed conversation is unavailable: ${document.body.textContent}`);
        }
        return candidate;
    });
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    onTestFinished(() => {
        vi.useRealTimers();
    });
    await app.user.click(conversation);
    // The latest page carries the compaction's terminal events; the page
    // boundary falls inside the same compaction's earlier events.
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentCompaction).textContent).toContain("Context compaction completed"),
    );
    const messages = queryByRole(document.body, "log", { name: "Messages" });
    if (!(messages instanceof HTMLElement)) {
        throw new Error("Expected the Session message list");
    }
    messages.scrollTop = 0;
    flushSync(() => messages.dispatchEvent(new Event("scroll", { bubbles: true })));

    // The older page's start and summary-chunk events merge with the newer
    // page's terminal update: one entry, full summary, no orphaned compacting twin.
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentCompaction).length).toBe(1);
        const compaction = app.elementByTestId(dataTestId.agentCompaction);
        expect(compaction.textContent).toContain("Context compaction completed");
        const summary = compaction.querySelector("pre");
        expect(summary?.textContent).toContain("The older history was compacted.");
        expect(summary?.textContent).toContain("Keep this text.");
        expect(compaction.textContent).not.toContain("compacting");
    });
});
