import { getByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { dataTestId } from "../../src/data-testid.ts";
import type { TestApp } from "./test-app.tsx";
import type { TestClock } from "./test-clock.ts";

export async function openAgentModelPicker(app: TestApp): Promise<void> {
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.agentSetting("model"),
            (element) => element instanceof HTMLButtonElement && !element.disabled,
        ),
    );
}

export async function sendPrompt(app: TestApp, composer: HTMLElement, prompt: string): Promise<void> {
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer to be a textarea");
    }
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

export async function openExecutionDetails(app: TestApp): Promise<HTMLElement> {
    await app.user.click(getByRole(document.body, "button", { name: /Switch computer/ }));
    await app.user.click(
        await app.waitForView(() => getByRole(document.body, "menuitem", { name: /View execution details/ })),
    );
    return app.waitForView(() => getByRole(document.body, "dialog", { name: "Execution details" }));
}

/** Observe recovery through the UI before advancing its uninterrupted grace period. */
export async function showReconnectNotice(app: TestApp, clock: TestClock): Promise<void> {
    await app.waitForView(() =>
        getByRole(document.body, "button", { name: /Switch computer/, description: "Reconnecting" }),
    );
    await act(async () => clock.advanceBy(8_000));
    await app.waitForView(() => getByRole(document.body, "button", { name: "Retry now" }));
}
