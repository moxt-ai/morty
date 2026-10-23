import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

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
