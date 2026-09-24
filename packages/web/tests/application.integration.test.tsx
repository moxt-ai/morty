import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { ToastProvider } from "../src/components/ui/toast.tsx";
import { dataTestId } from "../src/data-testid.ts";
import { ApiTransportProvider } from "../src/services/api/api-transport-context.tsx";
import { WorkspaceApplication } from "../src/views/authentication/session-application.tsx";
import { createChatWorkerEnvironment } from "./support/chat-worker.ts";

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Environment = Awaited<ReturnType<typeof createChatWorkerEnvironment>>;
type Application = Awaited<ReturnType<Environment["createApplication"]>>;

let environment: Environment;
let application: Application | null = null;
let root: Root | null = null;

beforeAll(async () => {
    environment = await createChatWorkerEnvironment();
});

afterEach(async () => {
    if (root !== null) {
        await act(async () => root?.unmount());
        root = null;
    }
    application?.close();
    application = null;
    document.body.replaceChildren();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
});

afterAll(async () => {
    await environment.close();
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

async function waitForText(selector: string, expected: string): Promise<HTMLElement> {
    return await vi.waitFor(
        () => {
            const element = document.querySelector<HTMLElement>(selector);
            if (element?.textContent?.includes(expected) !== true) {
                throw new Error(`Element did not show text: ${expected}; page: ${document.body.textContent}`);
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

async function waitForDialog(title: string): Promise<HTMLElement> {
    return await vi.waitFor(
        () => {
            const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((candidate) =>
                candidate.textContent?.includes(title),
            );
            if (dialog === undefined) {
                throw new Error(`Dialog did not appear: ${title}; page: ${document.body.textContent}`);
            }
            return dialog;
        },
        { timeout: 12_000 },
    );
}

async function renderWorkspace(created?: Application): Promise<Application> {
    const current = created ?? (await environment.createApplication());
    application = current;
    window.location.href = `${current.origin}/chat`;
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root?.render(
            <ApiTransportProvider transport={current.transport}>
                <ToastProvider>
                    <WorkspaceApplication
                        activeIdentity={current.identity}
                        authorize={async (signal) => signal.throwIfAborted()}
                        userId={current.userId}
                    />
                </ToastProvider>
            </ApiTransportProvider>,
        );
    });
    return current;
}

function observeStatusText(expected: string): Promise<HTMLElement> {
    return new Promise((resolve) => {
        const observer = new MutationObserver((records) => {
            for (const record of records) {
                for (const addedNode of record.addedNodes) {
                    if (!(addedNode instanceof HTMLElement)) {
                        continue;
                    }
                    const statuses = [
                        ...(addedNode.matches('[role="status"]') ? [addedNode] : []),
                        ...addedNode.querySelectorAll<HTMLElement>('[role="status"]'),
                    ];
                    const status = statuses.find((candidate) => candidate.textContent?.includes(expected) === true);
                    if (status !== undefined) {
                        observer.disconnect();
                        resolve(status);
                        return;
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });
}

function observeStatusLabel(expected: string): Promise<HTMLElement> {
    return new Promise((resolve) => {
        const observer = new MutationObserver((records) => {
            for (const record of records) {
                for (const addedNode of record.addedNodes) {
                    if (!(addedNode instanceof HTMLElement)) {
                        continue;
                    }
                    const statuses = [
                        ...(addedNode.matches('[role="status"]') ? [addedNode] : []),
                        ...addedNode.querySelectorAll<HTMLElement>('[role="status"]'),
                    ];
                    const status = statuses.find((candidate) => candidate.getAttribute("aria-label") === expected);
                    if (status !== undefined) {
                        observer.disconnect();
                        resolve(status);
                        return;
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });
}

function changeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const prototype =
        element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: value }));
}

async function sendPrompt(composer: HTMLTextAreaElement, prompt: string): Promise<void> {
    await act(async () => changeValue(composer, prompt));
    const send = await act(async () => await waitForEnabled(`[data-testid="${dataTestId.sendMessage}"]`));
    await act(async () => send.click());
}

test("Given the conversation directory is loading, When the workspace appears, Then an accessible skeleton replaces the loading copy", async () => {
    const loadingStatus = observeStatusText("Loading conversations");

    await renderWorkspace();

    expect((await loadingStatus).getAttribute("aria-label")).toBe("Loading conversations");
});

test("Given a shared workspace, When the user chooses to end remote access from the sidebar footer, Then they must confirm the transfer-wide revocation", {
    timeout: 30_000,
}, async () => {
    await renderWorkspace();
    const endAccess = await act(async () => await waitForElement('button[aria-label="End remote access"]'));
    const shareMachine = await act(async () => await waitForElement(`[data-testid="${dataTestId.shareMachine}"]`));

    expect(endAccess.parentElement).toBe(shareMachine.parentElement);
    await act(async () => endAccess.click());

    const dialog = await act(async () => await waitForDialog("End remote access?"));
    expect(dialog.textContent).toContain("End remote access?");
    expect(dialog.textContent).toContain("every browser using this access link");
    expect(dialog.textContent).toContain("Your local Runtime and task will keep running");
    expect(dialog.textContent).toContain("Cancel");
    expect(dialog.textContent).toContain("End remote access");
});

test("Given a conversation is working, When a user starts a new conversation, Then the background conversation keeps its working indicator", {
    timeout: 30_000,
}, async () => {
    const created = await renderWorkspace();
    const turnStarted = Promise.withResolvers<void>();
    const releaseTurn = Promise.withResolvers<void>();
    const { failure } = await act(
        async () =>
            await created.connectAgent({
                afterSessionStarted: async (_command, signal) => {
                    turnStarted.resolve();
                    await new Promise<void>((resolve, reject) => {
                        let settled = false;
                        const settle = (complete: () => void): void => {
                            if (settled) {
                                return;
                            }
                            settled = true;
                            signal.removeEventListener("abort", abort);
                            complete();
                        };
                        const release = (): void => {
                            settle(resolve);
                        };
                        const abort = (): void => {
                            settle(() => reject(signal.reason));
                        };
                        signal.addEventListener("abort", abort, { once: true });
                        void releaseTurn.promise.then(release);
                    });
                },
            }),
    );
    const composer = await act(async () => {
        await waitForText(`[data-testid="${dataTestId.botConnectionStatus}"]`, "Connected");
        return await waitForElement(`[data-testid="${dataTestId.messageComposer}"]`);
    });

    await sendPrompt(composer as HTMLTextAreaElement, "Keep working in the background");
    await Promise.race([turnStarted.promise, failure]);
    await act(async () => await waitForElement('[aria-label="Session working"]'));
    await act(async () => {
        (await waitForElement(`[data-testid="${dataTestId.newConversation}"]`)).click();
    });

    const backgroundConversation = await act(async () => {
        return await vi.waitFor(
            () => {
                const conversations = [
                    ...document.querySelectorAll<HTMLElement>(`[data-testid="${dataTestId.managedConversation}"]`),
                ];
                const conversation = conversations.find((candidate) =>
                    candidate.textContent?.includes("Keep working in the background"),
                );
                if (conversation === undefined) {
                    throw new Error(`The background conversation is unavailable: ${document.body.textContent}`);
                }
                const indicator = conversation.querySelector<HTMLElement>('[aria-label="Session working"]');
                if (indicator === null) {
                    throw new Error(
                        `The background conversation is not shown as working: ${document.body.textContent}`,
                    );
                }
                return conversation;
            },
            { timeout: 12_000 },
        );
    });
    expect(backgroundConversation.getAttribute("aria-current")).toBeNull();
    releaseTurn.resolve();
});

test("Given a paired Bot with loaded agent settings, When a user returns to a new conversation, Then the cached controls appear without loading again", {
    timeout: 30_000,
}, async () => {
    const created = await renderWorkspace();
    const initialLoading = observeStatusLabel("Loading harness and model settings");
    const { failure } = await act(async () => await created.connectAgent());
    expect((await initialLoading).textContent).toBe("");
    const composer = await act(async () => {
        await waitForText(`[data-testid="${dataTestId.botConnectionStatus}"]`, "Connected");
        await vi.waitFor(() =>
            expect(
                document.querySelector(`[data-testid="${dataTestId.agentConfiguration}"]`)?.getAttribute("title"),
            ).toContain("Test Small"),
        );
        return await waitForElement(`[data-testid="${dataTestId.messageComposer}"]`);
    });

    await sendPrompt(composer as HTMLTextAreaElement, "Cache these controls");
    await Promise.race([
        waitForText(`[data-testid="${dataTestId.managedConversation}"]`, "Cache these controls"),
        failure,
    ]);

    let settingsLoadedAgain = false;
    const observer = new MutationObserver(() => {
        settingsLoadedAgain ||= document.querySelector('[aria-label="Loading harness and model settings"]') !== null;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    await act(async () => (await waitForElement(`[data-testid="${dataTestId.newConversation}"]`)).click());
    await act(async () => {
        await vi.waitFor(() =>
            expect(
                document.querySelector(`[data-testid="${dataTestId.agentConfiguration}"]`)?.getAttribute("title"),
            ).toContain("Test Small"),
        );
    });
    observer.disconnect();

    expect(settingsLoadedAgain).toBe(false);
});

test("Given an unpaired workspace, When a user manages Bots, Then pairing and the surviving Bot remain visible", {
    timeout: 30_000,
}, async () => {
    await renderWorkspace();
    const [landing, connection] = await act(
        async () =>
            await Promise.all([
                waitForElement(`[data-testid="${dataTestId.chatLanding}"]`),
                waitForElement(`[data-testid="${dataTestId.botConnectionStatus}"]`),
            ]),
    );
    expect(landing.textContent).toContain("My Bot");
    const conversationSetup = await act(
        async () => await waitForElement(`[data-testid="${dataTestId.conversationSetupRequired}"]`),
    );
    expect(conversationSetup.textContent).toContain("No conversations yet");
    expect(conversationSetup.textContent).toContain("Connect Bot");
    expect(conversationSetup.getAttribute("role")).not.toBe("alert");

    const pairing = await act(async () => {
        connection.click();
        const pairAgain = await waitForElement(`[data-testid="${dataTestId.pairBotAgain}"]`);
        pairAgain.click();
        return await waitForElement(`[data-testid="${dataTestId.pairingInstruction}"]`);
    });
    expect(pairing).toBeInstanceOf(HTMLInputElement);
    expect((pairing as HTMLInputElement).value).toMatch(/^follow http:\/\/127\.0\.0\.1:\d+\/pair\.md\?token=/u);

    await act(async () => (await waitForElement(`[data-testid="${dataTestId.botMenuTrigger}"]`)).click());
    await act(async () => {
        (await waitForElement(`[data-testid="${dataTestId.createBot}"]`)).click();
        const name = await waitForElement(`[data-testid="${dataTestId.botNameInput}"]`);
        changeValue(name as HTMLInputElement, "Laptop Bot");
        (await waitForEnabled(`[data-testid="${dataTestId.confirmCreateBot}"]`)).click();
    });
    await act(async () => await waitForText(`[data-testid="${dataTestId.botMenuTrigger}"]`, "Laptop Bot"));
    await act(async () => {
        (await waitForElement(`[data-testid="${dataTestId.botMenuTrigger}"]`)).click();
        (await waitForElement(`[data-testid="${dataTestId.removeBot}"]`)).click();
        (await waitForElement(`[data-testid="${dataTestId.confirmRemoveBot}"]`)).click();
    });
    await act(async () => await waitForText(`[data-testid="${dataTestId.botMenuTrigger}"]`, "My Bot"));
    await act(async () => (await waitForElement(`[data-testid="${dataTestId.botMenuTrigger}"]`)).click());
    expect(document.querySelector(`[data-testid="${dataTestId.removeBot}"]`)).toBeNull();
});

test("Given a paired Bot with cached agent settings, When a user refreshes and filters its models, Then the reloaded configuration and requested media are visible", {
    timeout: 30_000,
}, async () => {
    const created = await renderWorkspace();
    const { failure } = await act(async () => await created.connectAgent());
    const composer = await act(async () => {
        await waitForText(`[data-testid="${dataTestId.botConnectionStatus}"]`, "Connected");
        return await waitForElement(`[data-testid="${dataTestId.messageComposer}"]`);
    });
    expect(composer).toBeInstanceOf(HTMLTextAreaElement);
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
    expect(document.querySelector(`[data-testid="${dataTestId.pairingInstruction}"]`)).toBeNull();

    await act(async () => {
        (await waitForElement(`[data-testid="${dataTestId.agentConfiguration}"]`)).click();
        const loading = observeStatusText("Loading harness settings");
        (await waitForElement('button[aria-label="Refresh agent settings"]')).click();
        await loading;
        await waitForEnabled(`[data-testid="${dataTestId.agentSetting("model")}"]`);
        (await waitForEnabled(`[data-testid="${dataTestId.agentSetting("model")}"]`)).click();
        const search = await waitForElement(`[data-testid="${dataTestId.modelSearch}"]`);
        changeValue(search as HTMLInputElement, "large");
    });
    await act(
        async () => await waitForText(`[data-testid="${dataTestId.sessionConfigValue("test-large")}"]`, "Test Large"),
    );
    expect(document.querySelector(`[data-testid="${dataTestId.sessionConfigValue("test-small")}"]`)).toBeNull();
    await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    const prompt = "Create an image";
    await sendPrompt(composer as HTMLTextAreaElement, prompt);
    await Promise.race([
        Promise.all([
            waitForText("body", prompt),
            waitForText("body", `Codex turn 1: ${prompt}`),
            waitForElement('img[alt="Generated image"]'),
        ]),
        failure,
    ]);
});

test("Given an Agent links a local file location, When a user opens it, Then the file path omits the source location", {
    timeout: 30_000,
}, async () => {
    const created = await renderWorkspace();
    const { failure } = await act(async () => await created.connectAgent());
    const composer = await act(async () => {
        await waitForText(`[data-testid="${dataTestId.botConnectionStatus}"]`, "Connected");
        return await waitForElement(`[data-testid="${dataTestId.messageComposer}"]`);
    });

    await sendPrompt(composer as HTMLTextAreaElement, "Open [Generated source](</fake/generated-image.png:104>)");
    const link = await Promise.race([waitForElement(`[data-testid="${dataTestId.localFileLink}"]`), failure]);
    await act(async () => link.click());

    await act(async () => await waitForElement(`[data-testid="${dataTestId.filePreview}"]`));
    await vi.waitFor(() => expect(document.querySelector('[title="/fake/generated-image.png"]')).not.toBeNull());
});

test("Given a user follows the latest message, When a response streams, Then the latest content remains visible", {
    timeout: 30_000,
}, async () => {
    const created = await renderWorkspace();
    const { failure } = await act(async () => await created.connectAgent());
    const composer = await act(async () => {
        await waitForText(`[data-testid="${dataTestId.botConnectionStatus}"]`, "Connected");
        return await waitForElement(`[data-testid="${dataTestId.messageComposer}"]`);
    });
    const draftMessages = await waitForElement('[role="log"][aria-label="Messages"]');
    await sendPrompt(composer as HTMLTextAreaElement, "Create an image");
    const messages = await vi.waitFor(() => {
        const current = document.querySelector<HTMLElement>('[role="log"][aria-label="Messages"]');
        if (current === null || current === draftMessages) {
            throw new Error("The active Session message list did not appear");
        }
        return current;
    });
    let scrollHeight = 800;
    let scrollTop = 100;
    Object.defineProperties(messages, {
        clientHeight: { configurable: true, get: () => 100 },
        scrollHeight: {
            configurable: true,
            get: () =>
                document.body.textContent?.includes("Codex turn 1: Create an image") === true ? scrollHeight : 200,
        },
        scrollTop: {
            configurable: true,
            get: () => scrollTop,
            set: (value: number) => {
                scrollTop = value;
            },
        },
    });
    messages.dispatchEvent(new Event("scroll"));

    await Promise.race([waitForText("body", "Codex turn 1: Create an image"), failure]);

    await vi.waitFor(() => expect(scrollTop).toBe(800));

    scrollTop = 700;
    messages.dispatchEvent(new Event("scroll"));
    scrollHeight = 1_200;
    const response = await waitForElement('article[aria-label="Agent response"]');
    response.textContent = `${response.textContent} More streamed content`;

    await vi.waitFor(() => expect(scrollTop).toBe(1_200));
});

test("Given a Bot has a recent directory from another harness, When its workspace loads, Then the directory remains available", {
    timeout: 30_000,
}, async () => {
    const created = await environment.createApplication();
    window.localStorage.setItem(
        `mobius:recent-cwd:${encodeURIComponent(created.botId)}`,
        JSON.stringify([{ directoryId: "saved-directory", directoryLabel: "/saved-by-another-harness" }]),
    );
    await renderWorkspace(created);
    const { failure } = await act(async () => await created.connectAgent());

    const menu = await Promise.race([
        act(async () => {
            const workingDirectory = await waitForElement(`[data-testid="${dataTestId.workingDirectory}"]`);
            workingDirectory.click();
            return await waitForText('[aria-label="Working directory menu"]', "/saved-by-another-harness");
        }),
        failure,
    ]);

    expect(menu.textContent).toContain("/saved-by-another-harness");
});

test("Given a Bot is bound to one Runtime, When another Runtime connects, Then native sessions stay scoped to the Bot", {
    timeout: 30_000,
}, async () => {
    const created = await renderWorkspace();
    const { failure: botRuntimeFailure } = await act(async () => await created.connectAgent());
    await act(async () => await waitForText(`[data-testid="${dataTestId.botConnectionStatus}"]`, "Connected"));
    const { failure: otherRuntimeFailure } = await act(async () => await created.connectRuntime());

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
    await Promise.race([
        vi.waitFor(() => {
            const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
            expect(options.map((option) => option.textContent)).toEqual(["Codex · Fake Runtime"]);
        }),
        botRuntimeFailure,
        otherRuntimeFailure,
    ]);
});
