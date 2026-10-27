import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a live user chunk with Codex browser context, When Chat displays it and reloads history, Then the actual request appears exactly once", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    const context =
        '<in-app-browser-context source="ambient-ui-state">\nThis block is automatically supplied ambient UI state, not part of the user\'s request.\n# In app browser:\n- Current URL: http://localhost:44208/\n</in-app-browser-context>\n\n## My request:\n\nHello from the GUI';
    await sendPrompt(app, composer, context);
    await app.waitForView(() => {
        const messages = app.elementsByTestId(dataTestId.userMessage);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.textContent).toBe("Hello from the GUI");
    });
    const reloaded = await app.reload();
    await reloaded.waitForView(() => {
        const messages = reloaded.elementsByTestId(dataTestId.userMessage);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.textContent).toBe("Hello from the GUI");
    });
});
