import { expect, onTestFinished, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

function usePointer(coarse: boolean): void {
    const matchMedia = window.matchMedia.bind(window);
    const spy = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
        const media = matchMedia(query);
        if (query === "(pointer: coarse)") {
            Object.defineProperty(media, "matches", { value: coarse });
        }
        return media;
    });
    onTestFinished(() => spy.mockRestore());
}

async function sendFirstMessage() {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    await sendPrompt(app, composer, "Hello");
    await app.waitForView(() => expect(app.elementsByTestId(dataTestId.agentResponse).length).toBeGreaterThan(0));
    return app;
}

test("Given a touch device, When I send a message, Then the composer releases focus so the software keyboard closes", {
    timeout: 30_000,
}, async () => {
    usePointer(true);
    const app = await sendFirstMessage();

    const composer = app.elementByTestId(dataTestId.messageComposer);
    expect(composer).not.toBe(document.activeElement);
});

test("Given a pointer device, When I send a message, Then the composer keeps focus for the next message", {
    timeout: 30_000,
}, async () => {
    usePointer(false);
    const app = await sendFirstMessage();

    const composer = app.elementByTestId(dataTestId.messageComposer);
    expect(composer).toBe(document.activeElement);
});
