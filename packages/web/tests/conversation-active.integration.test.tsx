import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given an active turn exceeds one recovery page, When the user leaves and reopens the conversation, Then Chat restores every character and rich content", {
    timeout: 30_000,
}, async () => {
    const prompt = "hold after large output";
    const expectedCharacters = 300_000;
    const app = await createTestApp({ connectAgent: true });
    const responseCharacters = () =>
        app
            .elementsByTestId(dataTestId.agentResponse)
            .flatMap((element) => element.textContent?.match(/x{100,}/gu) ?? [])
            .reduce((total, text) => total + text.length, 0);
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
    await app.waitForView(() => expect(responseCharacters()).toBe(expectedCharacters));
    await app.waitForView(() => expect(document.body.textContent).toContain("long-output.bin"));
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const activeConversation = await app.waitForView(() => {
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
    await app.waitForView(() => expect(responseCharacters()).toBe(expectedCharacters));
    await app.waitForView(() => expect(document.body.textContent).toContain("long-output.bin"));
    const stop = await app.queryElementByTestId(
        dataTestId.sendMessage,
        (element) => element.getAttribute("aria-label") === "Stop agent output",
    );
    await app.user.click(stop);
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    expect(document.body.textContent).toContain(prompt);
});
