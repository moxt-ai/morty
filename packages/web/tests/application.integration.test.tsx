import { getByRole, queryByRole, queryByTestId } from "@testing-library/dom";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { closeTestApps, closeTestEnvironment, createTestApp, type TestApp } from "./infra/test-app.tsx";

afterEach(async () => {
    await closeTestApps();
    document.body.replaceChildren();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
});

afterAll(async () => {
    await closeTestEnvironment();
});

function observeTestId(testId: string): Promise<HTMLElement> {
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

test("Given a native session handoff, When importing fails, Then the choice page shows progress and allows a fork retry", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: {
            harness: "codex",
            kind: "continue",
            sessionId: "01a0d270-0d62-7003-98df-22a5d11dc644",
        },
    });
    const importSession = await vi.waitFor(() => getByRole(document.body, "button", { name: "Import session" }));
    const forkSession = getByRole(document.body, "button", { name: "Fork session" });
    if (!(importSession instanceof HTMLButtonElement) || !(forkSession instanceof HTMLButtonElement)) {
        throw new Error("The native session actions are not buttons.");
    }

    await app.user.click(importSession);

    expect(importSession.disabled).toBe(true);
    expect(forkSession.disabled).toBe(true);
    expect(getByRole(importSession, "status", { name: "Importing session" })).toBeInstanceOf(HTMLElement);
    expect(queryByRole(document.body, "status", { name: "Securely transferring the workspace" })).toBeNull();

    await vi.waitFor(() => expect(getByRole(document.body, "alert")).toBeInstanceOf(HTMLElement));
    expect(getByRole(document.body, "heading", { name: "Continue native session" })).toBeInstanceOf(HTMLElement);
    expect(importSession.disabled).toBe(false);
    expect(forkSession.disabled).toBe(false);

    await app.user.click(forkSession);

    expect(getByRole(forkSession, "status", { name: "Forking session" })).toBeInstanceOf(HTMLElement);
});

async function sendPrompt(app: TestApp, composer: HTMLTextAreaElement, prompt: string): Promise<void> {
    await app.user.click(composer);
    await app.user.paste(prompt);
    const send = await app.queryElementByTestId(
        dataTestId.sendMessage,
        (element) => element instanceof HTMLButtonElement && !element.disabled,
    );
    await app.user.click(send);
}

test("Given a shared workspace, When the user opens the user menu, Then they can back up their token before replacing the current user", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    await app.user.click(await app.queryElementByTestId(dataTestId.userMenu));
    await app.user.click(await app.queryElementByTestId(dataTestId.replaceCurrentUser));

    const dialog = await app.queryElementByTestId(dataTestId.replaceCurrentUserDialog);
    expect(dialog.textContent).toContain("Replace current user");
    expect(dialog.textContent).toContain("Back up this token");
    expect(app.elementByTestId(dataTestId.currentUserToken, dialog)).toHaveProperty(
        "value",
        expect.stringMatching(/^mobius_recovery_v1\./u),
    );
    expect(app.elementByTestId(dataTestId.copyUserToken, dialog).getAttribute("aria-label")).toBe(
        "Copy current user token",
    );
    expect(app.elementByTestId(dataTestId.replacementUserToken, dialog).getAttribute("aria-label")).toBe(
        "Replacement user token",
    );
});

test("Given a shared workspace, When the user chooses to end remote access from the user menu, Then they must confirm the transfer-wide revocation and can back up their token", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    const shareMachine = await app.queryElementByTestId(dataTestId.shareMachine);

    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    const userMenu = await app.queryElementByTestId(dataTestId.userMenu);
    expect(userMenu.parentElement).toBe(shareMachine.parentElement);
    await app.user.click(userMenu);
    const endAccess = await app.queryElementByTestId(dataTestId.endRemoteAccess);
    await app.user.click(endAccess);

    const dialog = await app.queryElementByTestId(dataTestId.endRemoteAccessDialog);
    expect(dialog.textContent).toContain("End remote access?");
    expect(dialog.textContent).toContain("every browser using this access link");
    expect(dialog.textContent).toContain("Your local Runtime and task will keep running");
    expect(dialog.textContent).toContain("Back up this token");
    expect(app.elementByTestId(dataTestId.currentUserToken, dialog)).toHaveProperty(
        "value",
        expect.stringMatching(/^mobius_recovery_v1\./u),
    );
    expect(dialog.textContent).toContain("Cancel");
    expect(dialog.textContent).toContain("End remote access");
});

test("Given a conversation is working, When a user starts a new conversation, Then the background conversation keeps its working indicator", {
    timeout: 30_000,
}, async () => {
    const turnStarted = Promise.withResolvers<void>();
    const releaseTurn = Promise.withResolvers<void>();
    const created = await createTestApp({
        agentBehavior: {
            afterSessionStarted: async (...args: [signal: AbortSignal] | [command: unknown, signal: AbortSignal]) => {
                const signal = args.length === 1 ? args[0] : args[1];
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
                    const release = (): void => settle(resolve);
                    const abort = (): void => settle(() => reject(signal.reason));
                    signal.addEventListener("abort", abort, { once: true });
                    void releaseTurn.promise.then(release);
                });
            },
        },
        connectAgent: true,
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await created.queryElementByTestId(dataTestId.messageComposer);

    await sendPrompt(created, composer as HTMLTextAreaElement, "Keep working in the background");
    await Promise.race([turnStarted.promise, failure]);
    await created.queryElementByTestId(dataTestId.sessionStatus);
    await created.user.click(await created.queryElementByTestId(dataTestId.newConversation));

    const backgroundConversation = await vi.waitFor(
        () => {
            const conversations = created.elementsByTestId(dataTestId.managedConversation);
            const conversation = conversations.find((candidate) =>
                candidate.textContent?.includes("Keep working in the background"),
            );
            if (conversation === undefined) {
                throw new Error(`The background conversation is unavailable: ${document.body.textContent}`);
            }
            try {
                created.elementByTestId(dataTestId.sessionStatus, conversation);
            } catch {
                throw new Error(`The background conversation is not shown as working: ${document.body.textContent}`);
            }
            return conversation;
        },
        { timeout: 12_000 },
    );
    expect(backgroundConversation.getAttribute("aria-current")).toBeNull();
    releaseTurn.resolve();
});

test("Given an unpaired workspace, When a user manages Bots, Then pairing and the surviving Bot remain visible", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    const [landing, pairing] = await Promise.all([
        app.queryElementByTestId(dataTestId.chatLanding),
        app.queryElementByTestId(dataTestId.pairingInstruction),
    ]);
    expect(landing.textContent).toContain("My Bot");
    const conversationSetup = await app.queryElementByTestId(dataTestId.conversationSetupRequired);
    expect(conversationSetup.textContent).toContain("No conversations yet");
    expect(conversationSetup.textContent).toContain("Connect Bot");
    expect(conversationSetup.getAttribute("role")).not.toBe("alert");

    expect(pairing).toBeInstanceOf(HTMLInputElement);
    expect((pairing as HTMLInputElement).value).toMatch(/^follow http:\/\/127\.0\.0\.1:\d+\/pair\.md\?token=/u);

    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    await app.user.click(await app.queryElementByTestId(dataTestId.botMenuTrigger));
    await app.user.click(await app.queryElementByTestId(dataTestId.createBot));
    const name = await app.queryElementByTestId(dataTestId.botNameInput);
    await app.user.type(name, "Laptop Bot");
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.confirmCreateBot,
            (element) => element instanceof HTMLButtonElement && !element.disabled,
        ),
    );
    await app.queryElementByTestId(
        dataTestId.botMenuTrigger,
        (element) => element.textContent?.includes("Laptop Bot") === true,
    );
    await app.user.click(app.elementByTestId(dataTestId.botMenuTrigger));
    await app.user.click(await app.queryElementByTestId(dataTestId.removeBot));
    await app.user.click(await app.queryElementByTestId(dataTestId.confirmRemoveBot));
    await app.queryElementByTestId(
        dataTestId.botMenuTrigger,
        (element) => element.textContent?.includes("My Bot") === true,
    );
    await app.user.click(app.elementByTestId(dataTestId.botMenuTrigger));
    expect(app.optionalElementByTestId(dataTestId.removeBot)).toBeNull();
});

test("Given a paired Bot with cached agent settings, When a user refreshes and filters its models, Then the reloaded configuration and Agent reply are visible", {
    timeout: 30_000,
}, async () => {
    const created = await createTestApp({ connectAgent: true });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await created.queryElementByTestId(dataTestId.messageComposer);
    expect(composer).toBeInstanceOf(HTMLTextAreaElement);
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
    expect(created.optionalElementByTestId(dataTestId.pairingInstruction)).toBeNull();

    await created.user.click(await created.queryElementByTestId(dataTestId.agentConfiguration));
    const loading = observeTestId(dataTestId.agentSettingsLoading);
    await created.user.click(await created.queryElementByTestId(dataTestId.refreshAgentSettings));
    await loading;
    await created.user.click(
        await created.queryElementByTestId(
            dataTestId.agentSetting("model"),
            (element) => element instanceof HTMLButtonElement && !element.disabled,
        ),
    );
    const search = await created.queryElementByTestId(dataTestId.modelSearch);
    await created.user.type(search, "large");
    await created.queryElementByTestId(
        dataTestId.sessionConfigValue("test-large"),
        (element) => element.textContent?.includes("Test Large") === true,
    );
    expect(created.optionalElementByTestId(dataTestId.sessionConfigValue("test-small"))).toBeNull();
    await created.user.keyboard("{Escape}{Escape}");

    const prompt = "Create an image";
    await sendPrompt(created, composer as HTMLTextAreaElement, prompt);
    await Promise.race([
        Promise.all([
            created.queryElementByTestId(
                dataTestId.userMessage,
                (element) => element.textContent?.includes(prompt) === true,
            ),
            created.queryElementByTestId(
                dataTestId.agentResponse,
                (element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true,
            ),
        ]),
        failure,
    ]);
    await vi.waitFor(() => expect(created.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
});

test("Given an Agent links local file URLs, When they render and a user opens one, Then the image and source are available", {
    timeout: 30_000,
}, async () => {
    const created = await createTestApp({
        agentBehavior: {
            responseParts: () => [
                "Open [Generated source](</fake/generated-source.ts:104>)\n\n![QR code](file:///fake/generated-image.png)",
            ],
        },
        connectAgent: true,
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await created.queryElementByTestId(dataTestId.messageComposer);

    await sendPrompt(created, composer as HTMLTextAreaElement, "Show the generated local artifacts");
    const link = await Promise.race([created.queryElementByTestId(dataTestId.localFileLink), failure]);
    await vi.waitFor(() =>
        expect(getByRole(document.body, "img", { name: "QR code" })).toBeInstanceOf(HTMLImageElement),
    );
    await created.user.click(link);

    const preview = await created.queryElementByTestId(dataTestId.filePreview);
    expect(preview.textContent).not.toContain(":104");
    const content = await created.queryElementByTestId(dataTestId.filePreviewContent);
    expect(content.textContent).toContain("export const generated = true;");
});

test("Given a Bot has a recent directory from another harness, When its workspace loads, Then the directory remains available", {
    timeout: 30_000,
}, async () => {
    const created = await createTestApp({
        connectAgent: true,
        prepare: (current) =>
            window.localStorage.setItem(
                `mobius:recent-cwd:${encodeURIComponent(current.botId)}`,
                JSON.stringify([{ directoryId: "saved-directory", directoryLabel: "/saved-by-another-harness" }]),
            ),
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));

    const menu = await Promise.race([
        (async () => {
            const workingDirectory = await created.queryElementByTestId(dataTestId.workingDirectory);
            await created.user.click(workingDirectory);
            return await created.queryElementByTestId(
                dataTestId.recentWorkingDirectory,
                (element) => element.textContent?.includes("/saved-by-another-harness") === true,
            );
        })(),
        failure,
    ]);

    expect(menu.textContent).toContain("/saved-by-another-harness");
});
