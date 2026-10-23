import { queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

// The Worker checks the Runtime every 5 s and retries a failed check 5 s later, so one change can take two checks.
const RUNTIME_CHANGE_TIMEOUT_MS = 20_000;

function connectionStatus(app: TestApp): string | null {
    return app.elementByTestId(dataTestId.botConnectionStatus).getAttribute("data-connection-status");
}

function agentAnswered(app: TestApp, text: string): boolean {
    return app.elementsByTestId(dataTestId.agentResponse).some((message) => message.textContent?.includes(text));
}

test("Given a saved conversation, When opening it fails because its Runtime is offline and the Runtime comes back, Then the conversation opens without a reload", {
    timeout: 90_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    const draft = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    await sendPrompt(app, draft, "Keep this conversation");
    await app.waitForView(() => expect(agentAnswered(app, "Codex turn 1: Keep this conversation")).toBe(true));

    await daemon.disconnect();
    const reopened = await app.reload();
    // The conversation cannot open while the Runtime is offline: the page reports the failure and offers to retry.
    await reopened.waitForView(() => {
        expect(connectionStatus(reopened)).toBe("disconnected");
        expect(queryByRole(document.body, "button", { name: "Reconnect" })).not.toBeNull();
    }, RUNTIME_CHANGE_TIMEOUT_MS);

    await daemon.reconnect();
    await reopened.waitForView(() => {
        expect(connectionStatus(reopened)).toBe("connected");
        expect(agentAnswered(reopened, "Codex turn 1: Keep this conversation")).toBe(true);
        const composer = reopened.elementByTestId(dataTestId.messageComposer);
        expect(composer instanceof HTMLTextAreaElement && !composer.disabled).toBe(true);
    }, RUNTIME_CHANGE_TIMEOUT_MS);
});
