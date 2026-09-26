import { queryByTestId } from "@testing-library/dom";
import { afterAll, afterEach } from "vitest";
import { dataTestId } from "../../src/data-testid.ts";
import { closeTestApps, closeTestEnvironment, type TestApp } from "./test-app.tsx";

afterEach(async () => {
    await closeTestApps();
    document.body.replaceChildren();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
});

afterAll(async () => {
    await closeTestEnvironment();
});

export function observeTestId(testId: string): Promise<HTMLElement> {
    return new Promise((resolve) => {
        const observer = new MutationObserver(() => {
            const element = queryByTestId(document.body, testId);
            if (element !== null) {
                observer.disconnect();
                resolve(element);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });
}

export async function sendPrompt(app: TestApp, composer: HTMLTextAreaElement, prompt: string): Promise<void> {
    await app.user.click(composer);
    await app.user.paste(prompt);
    const send = await app.queryElementByTestId(
        dataTestId.sendMessage,
        (element) => element instanceof HTMLButtonElement && !element.disabled,
    );
    await app.user.click(send);
}
