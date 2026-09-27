import { expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a controlled Agent turn is active, When the user leaves and reopens the conversation, Then the real daemon restores its live state", {
    timeout: 30_000,
}, async () => {
    const prompt = "wait until cancelled";
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
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const activeConversation = await vi.waitFor(() => {
        const conversation = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((candidate) => candidate.textContent?.includes(prompt) === true);
        if (conversation === undefined) {
            throw new Error(`The active conversation is unavailable: ${document.body.textContent}`);
        }
        return conversation;
    });
    await app.user.click(activeConversation);
    await app.queryElementByTestId(dataTestId.sessionStatus);
    const stop = await app.queryElementByTestId(
        dataTestId.sendMessage,
        (element) => element.getAttribute("aria-label") === "Stop agent output",
    );
    await app.user.click(stop);
    await vi.waitFor(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    expect(document.body.textContent).toContain(prompt);
});
