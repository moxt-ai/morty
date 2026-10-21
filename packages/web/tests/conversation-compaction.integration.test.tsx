import { getByRole, queryByRole } from "@testing-library/dom";
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

    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentCompaction).textContent).toContain("Context compaction completed"),
    );
    // A settled compaction collapses by default; expanding it reveals the summary.
    const compaction = app.elementByTestId(dataTestId.agentCompaction);
    const disclosureButton = getByRole(compaction, "button");
    await app.user.click(disclosureButton);
    await app.waitForView(() => {
        const expanded = app.elementByTestId(dataTestId.agentCompaction);
        expect(getByRole(expanded, "button").getAttribute("aria-expanded")).toBe("true");
        const summary = expanded.querySelector("pre");
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

    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentCompaction).textContent).toContain("Context compaction completed"),
    );
    const compaction = app.elementByTestId(dataTestId.agentCompaction);
    await app.user.click(getByRole(compaction, "button"));
    await app.waitForView(() => {
        const expanded = app.elementByTestId(dataTestId.agentCompaction);
        const summary = expanded.querySelector("pre");
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
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentCompaction).textContent).toContain("Context compaction completed"),
    );
    await app.user.click(getByRole(app.elementByTestId(dataTestId.agentCompaction), "button"));
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

test("Given a history page that starts inside an interleaved compaction, When the user loads older messages, Then the older page's start merges into the same compaction entry", {
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

    await sendPrompt(app, composer, "interleaved compaction hold");
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentCompaction).textContent).toContain("Context compaction compacting"),
    );
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Message between compaction start and settle.")),
        ).toBe(true),
    );
    if (app.daemon === null) {
        throw new Error("Expected the controlled Agent");
    }
    await app.daemon.continueReply("interleaved compaction hold", {
        outcome: "complete",
        output: [
            {
                kind: "compaction-finish",
                summary: "First half of the interleaved summary.\nSecond half of the interleaved summary.",
            },
        ],
    });
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentCompaction).textContent).toContain("Context compaction completed"),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());

    // Three filler turns place the session-history page boundary exactly after
    // the compaction's start: 26 events follow it across these turns plus the 4
    // that already trailed (interleaved message, chunk, completed, turn end), so
    // the newest 30-event page begins with the interleaved message.
    const fillers = [
        { completion: "Interleave reply", prompt: "interleave padding one" },
        { completion: "Interleave reply", prompt: "interleave padding two" },
        { completion: "Interleave reply tail", prompt: "interleave padding three" },
    ];
    for (const filler of fillers) {
        const activeComposer = await app.queryElementByTestId(dataTestId.messageComposer);
        if (!(activeComposer instanceof HTMLTextAreaElement)) {
            throw new Error("Expected the message composer");
        }
        await sendPrompt(app, activeComposer, filler.prompt);
        await app.waitForView(() =>
            expect(
                app
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((element) => element.textContent?.includes(filler.completion)),
            ).toBe(true),
        );
        await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    }

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const conversation = await app.waitForView(() => {
        const candidate = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => element.textContent?.includes("interleaved compaction hold") === true);
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
    // The newest page's first compaction event is the settle chunk, not the
    // start: the entry must still render immediately as one completed
    // compaction, without loading the older page that holds the start.
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentCompaction).length).toBe(1);
        expect(app.elementByTestId(dataTestId.agentCompaction).textContent).toContain("Context compaction completed");
    });
    const messages = queryByRole(document.body, "log", { name: "Messages" });
    if (!(messages instanceof HTMLElement)) {
        throw new Error("Expected the Session message list");
    }
    messages.scrollTop = 0;
    flushSync(() => messages.dispatchEvent(new Event("scroll", { bubbles: true })));

    // The older page's start and the newest page's settle events merge under
    // one compaction id with the whole summary; no second, compacting twin.
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentCompaction).textContent).toContain("Context compaction completed"),
    );
    await app.user.click(getByRole(app.elementByTestId(dataTestId.agentCompaction), "button"));
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentCompaction).length).toBe(1);
        const compaction = app.elementByTestId(dataTestId.agentCompaction);
        const summary = compaction.querySelector("pre");
        expect(summary?.textContent).toContain("First half of the interleaved summary.");
        expect(summary?.textContent).toContain("Second half of the interleaved summary.");
        expect(compaction.textContent).not.toContain("compacting");
    });
});

test("Given a compaction is streaming in progress, When the user collapses and re-expands it, Then the choice overrides the status default and survives the terminal update", {
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

    await sendPrompt(app, composer, "interleaved compaction hold");
    // In-progress default: expanded, streaming summary visible.
    await app.waitForView(() => {
        const compaction = app.elementByTestId(dataTestId.agentCompaction);
        expect(compaction.textContent).toContain("Context compaction compacting");
        expect(getByRole(compaction, "button").getAttribute("aria-expanded")).toBe("true");
    });

    // The user collapses while it is still in progress: the choice wins over
    // the status default, so the summary hides immediately.
    await app.user.click(getByRole(app.elementByTestId(dataTestId.agentCompaction), "button"));
    await app.waitForView(() => {
        const compaction = app.elementByTestId(dataTestId.agentCompaction);
        expect(getByRole(compaction, "button").getAttribute("aria-expanded")).toBe("false");
        expect(compaction.querySelector("pre")).toBeNull();
    });

    // Re-expand: still in progress, the disclosure opens again (no summary has
    // streamed yet - the chunk arrives with the settle).
    await app.user.click(getByRole(app.elementByTestId(dataTestId.agentCompaction), "button"));
    await app.waitForView(() => {
        const compaction = app.elementByTestId(dataTestId.agentCompaction);
        expect(getByRole(compaction, "button").getAttribute("aria-expanded")).toBe("true");
    });

    if (app.daemon === null) {
        throw new Error("Expected the controlled Agent");
    }
    await app.daemon.continueReply("interleaved compaction hold", {
        outcome: "complete",
        output: [{ kind: "compaction-finish", summary: "Settled summary after re-expansion." }],
    });
    // The explicit expanded choice survives the terminal update: no sudden
    // auto-collapse when the compaction settles.
    await app.waitForView(() => {
        const compaction = app.elementByTestId(dataTestId.agentCompaction);
        expect(compaction.textContent).toContain("Context compaction completed");
        expect(getByRole(compaction, "button").getAttribute("aria-expanded")).toBe("true");
        expect(compaction.querySelector("pre")?.textContent).toContain("Settled summary after re-expansion.");
    });
});
