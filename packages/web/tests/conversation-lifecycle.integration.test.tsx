import { expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given an unsent message draft, When the user reloads Chat, Then the draft remains in the composer", {
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
    await app.user.type(composer, "Keep this unsent draft");
    app.reload();
    const restored = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(restored instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the restored message composer");
    }
    await vi.waitFor(() => expect(restored.value).toBe("Keep this unsent draft"));
});

test("Given the real daemon completed a turn, When the user leaves and reopens it, Then persisted harness history restores one conversation", {
    timeout: 30_000,
}, async () => {
    const prompt = "Persist this completed conversation";
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
    await app.queryElementByTestId(
        dataTestId.agentResponse,
        (element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true,
    );
    await vi.waitFor(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const conversation = await vi.waitFor(() => {
        const candidate = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((element) => element.textContent?.includes(prompt) === true);
        if (candidate === undefined) {
            throw new Error(`The completed conversation is unavailable: ${document.body.textContent}`);
        }
        return candidate;
    });
    await app.user.click(conversation);
    await vi.waitFor(() => expect(document.body.textContent).toContain(prompt));
    expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
});
