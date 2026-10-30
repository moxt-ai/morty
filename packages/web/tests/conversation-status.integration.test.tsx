import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { createChatWorkerEnvironment } from "./support/chat-worker.ts";

async function readyComposer(app: TestApp): Promise<HTMLTextAreaElement> {
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    return composer;
}

function directoryEntry(app: TestApp, title: string): HTMLElement | undefined {
    return app.elementsByTestId(dataTestId.managedConversation).find((entry) => entry.textContent?.includes(title));
}

/** The accessible label of the status a directory entry shows, or null when it shows none. */
function entryStatus(app: TestApp, title: string): string | null {
    const entry = directoryEntry(app, title);
    return entry?.querySelector(`[data-testid="${dataTestId.sessionStatus}"]`)?.getAttribute("aria-label") ?? null;
}

test("Given a conversation whose turn failed, When the directory reloads with the Session idle, Then the sidebar still marks it failed", {
    timeout: 30_000,
}, async () => {
    const failedPrompt = "fail this turn explicitly";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );

    await sendPrompt(app, await readyComposer(app), failedPrompt);
    await app.waitForView(() => expect(entryStatus(app, failedPrompt)).toBe("Session failed"));

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    // Starting another conversation reloads the directory, whose snapshot reports the failed Session as idle.
    await sendPrompt(app, await readyComposer(app), "Start another conversation");
    await app.waitForView(() => {
        expect(directoryEntry(app, "Start another conversation")).toBeDefined();
        expect(entryStatus(app, failedPrompt)).toBe("Session failed");
    });
});

test("Given an open conversation, When I send a message the Runtime has not received yet, Then the sidebar marks it working with the pane and clears the mark when the reply completes", {
    timeout: 30_000,
}, async () => {
    const firstPrompt = "Start a conversation to follow up";
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const { executionNetwork } = app;
    if (executionNetwork === null) {
        throw new Error("Expected the execution transport proxy");
    }
    await sendPrompt(app, await readyComposer(app), firstPrompt);
    await app.waitForView(() => {
        expect(document.body.textContent).toContain(`Codex turn 1: ${firstPrompt}`);
        expect(directoryEntry(app, firstPrompt)).toBeDefined();
        expect(entryStatus(app, firstPrompt)).toBeNull();
    });

    const submission = executionNetwork.holdNextSubmission();
    await sendPrompt(app, await readyComposer(app), "Follow up while the Runtime waits");
    const release = await submission;
    // The Runtime has not received the message, so only the open pane knows the conversation works.
    await app.waitForView(() => expect(entryStatus(app, firstPrompt)).toBe("Session working"));

    release();
    await app.waitForView(() => {
        expect(document.body.textContent).toContain("Codex turn 2: Follow up while the Runtime waits");
        expect(entryStatus(app, firstPrompt)).toBeNull();
    });
    await app.close();
});
