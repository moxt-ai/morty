import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { ToastProvider } from "../src/components/ui/toast.tsx";
import { dataTestId } from "../src/data-testid.ts";
import { ApiTransportProvider } from "../src/services/api/api-transport-context.tsx";
import { WorkspaceApplication } from "../src/views/authentication/session-application.tsx";
import { applicationIdentity, ChatTransport } from "./support/chat-transport.ts";

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

function waitForElement(selector: string): Promise<HTMLElement> {
    const existing = document.querySelector<HTMLElement>(selector);
    if (existing !== null) {
        return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Element did not appear: ${selector}`));
        }, 1_000);
        const observer = new MutationObserver(() => {
            const element = document.querySelector<HTMLElement>(selector);
            if (element !== null) {
                window.clearTimeout(timeout);
                observer.disconnect();
                resolve(element);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });
}

async function waitForText(selector: string, text: string): Promise<HTMLElement> {
    const element = document.querySelector<HTMLElement>(selector);
    if (element?.textContent === text) {
        return element;
    }
    return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Element did not show text: ${text}`));
        }, 1_000);
        const observer = new MutationObserver(() => {
            const current = document.querySelector<HTMLElement>(selector);
            if (current?.textContent === text) {
                window.clearTimeout(timeout);
                observer.disconnect();
                resolve(current);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });
}

async function waitForTitle(selector: string, title: string): Promise<HTMLElement> {
    const element = document.querySelector<HTMLElement>(selector);
    if (element?.title === title) {
        return element;
    }
    return await new Promise((resolve) => {
        const observer = new MutationObserver(() => {
            const current = document.querySelector<HTMLElement>(selector);
            if (current?.title === title) {
                observer.disconnect();
                resolve(current);
            }
        });
        observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    });
}

test("Given an offline paired Agent, When the Web application opens, Then Chat remains usable and offers a valid pairing instruction", async () => {
    window.history.replaceState(null, "", "/chat");
    const transport = new ChatTransport();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
        root?.render(
            <ApiTransportProvider transport={transport}>
                <ToastProvider>
                    <WorkspaceApplication
                        activeIdentity={applicationIdentity}
                        authorize={async (signal) => signal.throwIfAborted()}
                        userId="user-one"
                    />
                </ToastProvider>
            </ApiTransportProvider>,
        );
    });
    const [landing, connection, pairing] = await act(
        async () =>
            await Promise.all([
                waitForElement(`[data-testid="${dataTestId.chatLanding}"]`),
                waitForElement(`[data-testid="${dataTestId.botConnectionStatus}"]`),
                waitForElement(`[data-testid="${dataTestId.pairingInstruction}"]`),
            ]),
    );

    expect(landing.textContent).toContain("Local agent");
    expect(connection.textContent).toBe("Disconnected");
    expect(pairing).toBeInstanceOf(HTMLInputElement);
    expect((pairing as HTMLInputElement).value).toMatch(/^follow http:\/\/localhost:\d+\/pair\.md\?token=/u);

    const composer = await act(async () => {
        transport.connectAgent();
        await waitForText(`[data-testid="${dataTestId.botConnectionStatus}"]`, "Connected");
        return await waitForElement(`[data-testid="${dataTestId.messageComposer}"]`);
    });
    expect(composer).toBeInstanceOf(HTMLTextAreaElement);
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
    expect(document.querySelector(`[data-testid="${dataTestId.pairingInstruction}"]`)).toBeNull();
});

test("Given a user selected agent settings, When they create a new draft conversation, Then their last settings are restored", async () => {
    window.history.replaceState(null, "", "/chat");
    const transport = new ChatTransport();
    transport.connectAgent();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
        root?.render(
            <ApiTransportProvider transport={transport}>
                <ToastProvider>
                    <WorkspaceApplication
                        activeIdentity={applicationIdentity}
                        authorize={async (signal) => signal.throwIfAborted()}
                        userId="user-one"
                    />
                </ToastProvider>
            </ApiTransportProvider>,
        );
    });
    const configuration = await act(
        async () =>
            await waitForTitle(
                `[data-testid="${dataTestId.agentConfiguration}"]`,
                "OpenCode · Development Mac · Model One",
            ),
    );
    await act(async () => configuration.click());
    const model = await act(async () => await waitForElement(`[data-testid="${dataTestId.agentSetting("model")}"]`));
    await act(async () => model.click());
    const modelTwo = await act(
        async () => await waitForElement(`[data-testid="${dataTestId.sessionConfigValue("model-two")}"]`),
    );
    await act(async () => modelTwo.click());
    await act(
        async () =>
            await waitForTitle(
                `[data-testid="${dataTestId.agentConfiguration}"]`,
                "OpenCode · Development Mac · Model Two",
            ),
    );

    const newConversation = await act(
        async () => await waitForElement(`[data-testid="${dataTestId.newConversation}"]`),
    );
    await act(async () => newConversation.click());

    const restored = await act(
        async () =>
            await waitForTitle(
                `[data-testid="${dataTestId.agentConfiguration}"]`,
                "OpenCode · Development Mac · Model Two",
            ),
    );
    expect(restored.title).toBe("OpenCode · Development Mac · Model Two");
});

test("Given an open Session loses its Runtime, When the same Runtime reconnects, Then the page reports Connected again", async () => {
    window.history.replaceState(null, "", "/chat?sessionId=session-one");
    const transport = new ChatTransport();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
        root?.render(
            <ApiTransportProvider transport={transport}>
                <ToastProvider>
                    <WorkspaceApplication
                        activeIdentity={applicationIdentity}
                        authorize={async (signal) => signal.throwIfAborted()}
                        userId="user-one"
                    />
                </ToastProvider>
            </ApiTransportProvider>,
        );
    });
    await act(async () => await waitForText(`[data-testid="${dataTestId.botConnectionStatus}"]`, "Disconnected"));

    await act(async () => {
        transport.connectAgent();
        await waitForText(`[data-testid="${dataTestId.botConnectionStatus}"]`, "Connected");
    });
});

test("Given a conversation cannot load its Session, When Chat opens it, Then the client shows the load error", async () => {
    window.history.replaceState(null, "", "/chat?conversationId=conversation-one");
    const transport = new ChatTransport();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
        root?.render(
            <ApiTransportProvider transport={transport}>
                <ToastProvider>
                    <WorkspaceApplication
                        activeIdentity={applicationIdentity}
                        authorize={async (signal) => signal.throwIfAborted()}
                        userId="user-one"
                    />
                </ToastProvider>
            </ApiTransportProvider>,
        );
    });

    const failure = await act(async () => await waitForElement(`[data-testid="${dataTestId.sessionLoadFailure}"]`));
    expect(failure.textContent).toBe("Platform returned an unexpected Session.");
});
