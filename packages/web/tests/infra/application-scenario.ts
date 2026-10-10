import { dataTestId } from "../../src/data-testid.ts";
import type { TestApp } from "./test-app.tsx";

export async function sendPrompt(app: TestApp, composer: HTMLTextAreaElement, prompt: string): Promise<void> {
    const readyComposer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    await app.user.click(readyComposer);
    await app.user.paste(prompt);
    const send = await app.waitForView(() => {
        const element = app.elementByTestId(dataTestId.sendMessage);
        if (
            !(element instanceof HTMLButtonElement) ||
            element.disabled ||
            element.getAttribute("aria-label") !== "Send message"
        ) {
            throw new Error(
                `Send is unavailable: draft=${composer.value}, disabled=${composer.disabled}, connected=${composer.isConnected}, button=${element.getAttribute("aria-label")}`,
            );
        }
        return element;
    });
    await app.user.click(send);
}
