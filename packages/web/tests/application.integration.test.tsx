import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { ToastProvider } from "../src/components/ui/toast.tsx";
import { dataTestId } from "../src/data-testid.ts";
import { ApiTransportProvider } from "../src/services/api/api-transport-context.tsx";
import { WorkspaceApplication } from "../src/views/authentication/session-application.tsx";
import { createChatWorker } from "./support/chat-worker.ts";

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
    if (root !== null) {
        await act(async () => root?.unmount());
        root = null;
    }
    document.body.replaceChildren();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
});

async function waitForElement(selector: string): Promise<HTMLElement> {
    return await vi.waitFor(
        () => {
            const element = document.querySelector<HTMLElement>(selector);
            if (element === null) {
                throw new Error(`Element did not appear: ${selector}; page: ${document.body.textContent}`);
            }
            return element;
        },
        { timeout: 12_000 },
    );
}

async function waitForText(selector: string, text: string): Promise<HTMLElement> {
    return await vi.waitFor(
        () => {
            const element = document.querySelector<HTMLElement>(selector);
            if (element?.textContent?.includes(text) !== true) {
                throw new Error(`Element did not show text: ${text}; page: ${document.body.textContent}`);
            }
            return element;
        },
        { timeout: 12_000 },
    );
}

async function waitForEnabled(selector: string): Promise<HTMLButtonElement> {
    return await vi.waitFor(
        () => {
            const element = document.querySelector<HTMLButtonElement>(selector);
            if (element === null || element.disabled) {
                throw new Error(`Element did not become enabled: ${selector}`);
            }
            return element;
        },
        { timeout: 12_000 },
    );
}

async function sendPrompt(composer: HTMLTextAreaElement, prompt: string): Promise<void> {
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(composer, prompt);
        composer.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: prompt }));
    });
    const send = await act(async () => await waitForEnabled(`[data-testid="${dataTestId.sendMessage}"]`));
    await act(async () => send.click());
}

test("Given an unpaired workspace, When its Agent responds with local media, Then the real Chat stack renders it", {
    timeout: 30_000,
}, async () => {
    const fixture = await createChatWorker();
    window.location.href = `${fixture.origin}/chat`;
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    try {
        await act(async () => {
            root?.render(
                <ApiTransportProvider transport={fixture.transport}>
                    <ToastProvider>
                        <WorkspaceApplication
                            activeIdentity={fixture.identity}
                            authorize={async (signal) => signal.throwIfAborted()}
                            userId={fixture.userId}
                        />
                    </ToastProvider>
                </ApiTransportProvider>,
            );
        });
        const [landing, connection] = await act(
            async () =>
                await Promise.all([
                    waitForElement(`[data-testid="${dataTestId.chatLanding}"]`),
                    waitForElement(`[data-testid="${dataTestId.botConnectionStatus}"]`),
                ]),
        );

        expect(landing.textContent).toContain("My Bot");
        const pairing = await act(async () => {
            connection.click();
            const pairAgain = await waitForElement(`[data-testid="${dataTestId.pairBotAgain}"]`);
            pairAgain.click();
            return await waitForElement(`[data-testid="${dataTestId.pairingInstruction}"]`);
        });
        expect(pairing).toBeInstanceOf(HTMLInputElement);
        expect((pairing as HTMLInputElement).value).toMatch(/^follow http:\/\/127\.0\.0\.1:\d+\/pair\.md\?token=/u);

        const { failure: agentFailure } = await act(async () => await fixture.connectAgent());
        const composer = await act(async () => {
            await waitForText(`[data-testid="${dataTestId.botConnectionStatus}"]`, "Connected");
            return await waitForElement(`[data-testid="${dataTestId.messageComposer}"]`);
        });
        expect(composer).toBeInstanceOf(HTMLTextAreaElement);
        expect((composer as HTMLTextAreaElement).disabled).toBe(false);
        expect(document.querySelector(`[data-testid="${dataTestId.pairingInstruction}"]`)).toBeNull();

        const prompt = "Create an image";
        await sendPrompt(composer as HTMLTextAreaElement, prompt);
        await Promise.race([
            Promise.all([
                waitForText("body", prompt),
                waitForText("body", `Codex turn 1: ${prompt}`),
                waitForElement('img[alt="Generated image"]'),
            ]),
            agentFailure,
        ]);
    } finally {
        if (root !== null) {
            await act(async () => root?.unmount());
            root = null;
        }
        await fixture.close();
    }
});

test("Given a Bot bound to one Runtime while an older pairing of the same machine is still listed, When the user opens Native Sessions, Then the agent selector offers only the bound Runtime's agents", {
    timeout: 30_000,
}, async () => {
    const fixture = await createChatWorker();
    window.location.href = `${fixture.origin}/chat`;
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    try {
        await act(async () => {
            root?.render(
                <ApiTransportProvider transport={fixture.transport}>
                    <ToastProvider>
                        <WorkspaceApplication
                            activeIdentity={fixture.identity}
                            authorize={async (signal) => signal.throwIfAborted()}
                            userId={fixture.userId}
                        />
                    </ToastProvider>
                </ApiTransportProvider>,
            );
        });
        await act(async () => await waitForElement(`[data-testid="${dataTestId.chatLanding}"]`));
        await act(async () => await fixture.connectAgent());
        await act(async () => await fixture.connectRuntime());
        await act(async () => {
            await waitForText(`[data-testid="${dataTestId.botConnectionStatus}"]`, "Connected");
        });

        const nativeSessions = await act(async () => {
            const button = await waitForElement('button[aria-label="Native Sessions"]');
            button.click();
            return await waitForElement('button[aria-label="Session agent"]');
        });
        await act(async () => {
            nativeSessions.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            await vi.waitFor(
                () => {
                    if (document.querySelectorAll('[role="option"]').length === 0) {
                        throw new Error(`No agent options appeared; page: ${document.body.textContent}`);
                    }
                },
                { timeout: 12_000 },
            );
        });
        const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
        expect(options.map((option) => option.textContent)).toEqual(["Codex · Fake Runtime"]);
    } finally {
        if (root !== null) {
            await act(async () => root?.unmount());
            root = null;
        }
        await fixture.close();
    }
});
