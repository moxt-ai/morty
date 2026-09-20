import type { SessionConfigOption, WorkspaceEntriesEvent } from "@moxt-ai/mobius-protocol";
import { createStore } from "zustand/vanilla";
import type { BotChatApi, ChatDraftConfiguration, ChatWorkspace } from "@/services/chat/bot-chat-api";
import { readLastCwdPreference, saveLastCwdPreference } from "@/services/chat/last-cwd-preference";

type DraftSettingsState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly message: string }
    | {
          readonly kind: "ready";
          readonly workspace: ChatWorkspace;
          readonly bindingId: string;
          readonly cwd: WorkspaceEntriesEvent;
          readonly options: readonly SessionConfigOption[];
      };

type CwdBrowserState =
    | { readonly kind: "closed" }
    | { readonly kind: "loading"; readonly path: string }
    | { readonly kind: "ready"; readonly directory: WorkspaceEntriesEvent; readonly path: string }
    | {
          readonly kind: "failed";
          readonly directory: WorkspaceEntriesEvent;
          readonly message: string;
          readonly path: string;
      };

export interface DraftControlsStore {
    readonly cwdBrowser: CwdBrowserState;
    readonly settings: DraftSettingsState;
    readonly browseCwd: (directoryId: string, signal: AbortSignal) => Promise<void>;
    readonly closeCwd: () => void;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly openCwd: () => void;
    readonly saveCwd: (signal: AbortSignal) => Promise<void>;
    readonly selectHarness: (value: string, disabled: boolean, signal: AbortSignal) => Promise<void>;
    readonly selectOption: (configId: string, value: string) => void;
    readonly toggleOption: (configId: string) => void;
    readonly setCwdPath: (path: string) => void;
}

function pathDirectoryId(path: string): string {
    const bytes = new TextEncoder().encode(path);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return `path-${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}

function failureMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : "The working directory is unavailable.";
}

function wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timeout = window.setTimeout(finish, 1_000);
        function finish(): void {
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", finish);
            resolve();
        }
        signal.addEventListener("abort", finish, { once: true });
    });
}

export const createDraftControlsStore = (
    botId: string,
    requests: Pick<BotChatApi, "workspace" | "workspaceDirectory" | "selectAgent" | "agentSettings">,
    onSettings: (settings: ChatDraftConfiguration | null) => void,
    storage: Storage,
) =>
    createStore<DraftControlsStore>()((set, get) => {
        let cwdOperation: AbortController | null = null;
        let selectedHarness = "";
        const changedOptionIds = new Set<string>();
        const publishSettings = (settings: Extract<DraftSettingsState, { readonly kind: "ready" }>): void => {
            onSettings({
                bindingId: settings.bindingId,
                workspaceRef: settings.cwd.directoryId,
                workspaceLabel: settings.cwd.directoryLabel,
                configurations: settings.options
                    .filter((option) => option.category === "model" || changedOptionIds.has(option.id))
                    .map((option) => ({
                        booleanValue: option.type === "boolean" ? option.booleanValue : false,
                        configId: option.id,
                        value: option.type === "select" ? option.currentValue : "",
                        valueType: option.type,
                    })),
            });
        };
        const browseCwd = async (directoryId: string, lifetimeSignal: AbortSignal): Promise<void> => {
            const settings = get().settings;
            if (settings.kind !== "ready") {
                return;
            }
            const currentBrowser = get().cwdBrowser;
            const previousPath = currentBrowser.kind === "closed" ? settings.cwd.directoryLabel : currentBrowser.path;
            const previousDirectory =
                currentBrowser.kind === "ready" || currentBrowser.kind === "failed"
                    ? currentBrowser.directory
                    : settings.cwd;
            cwdOperation?.abort();
            const operation = new AbortController();
            cwdOperation = operation;
            const signal = AbortSignal.any([lifetimeSignal, operation.signal, AbortSignal.timeout(120_000)]);
            set({ cwdBrowser: { kind: "loading", path: previousPath } });
            try {
                const directory = await requests.workspaceDirectory(botId, directoryId, signal);
                signal.throwIfAborted();
                set({ cwdBrowser: { kind: "ready", directory, path: directory.directoryLabel } });
            } catch (cause) {
                if (operation.signal.aborted) {
                    return;
                }
                lifetimeSignal.throwIfAborted();
                set({
                    cwdBrowser: {
                        kind: "failed",
                        directory: previousDirectory,
                        message: failureMessage(cause),
                        path: previousPath,
                    },
                });
            } finally {
                if (cwdOperation === operation) {
                    cwdOperation = null;
                }
            }
        };
        const load = async (lifetimeSignal: AbortSignal): Promise<void> => {
            const signal = AbortSignal.any([lifetimeSignal, AbortSignal.timeout(120_000)]);
            set({ settings: { kind: "loading" } });
            onSettings(null);
            try {
                while (!signal.aborted) {
                    const workspace = await requests.workspace(botId, signal);
                    const selected = workspace.selected;
                    if (
                        selected !== null &&
                        (selectedHarness === "" || `${selected.runtimeId}:${selected.agentRef}` === selectedHarness)
                    ) {
                        const [result, defaultCwd] = await Promise.all([
                            requests.agentSettings(botId, signal),
                            requests.workspaceDirectory(botId, selected.workspaceRef, signal),
                        ]);
                        signal.throwIfAborted();
                        const savedDirectoryId = readLastCwdPreference(
                            storage,
                            botId,
                            selected.runtimeId,
                            selected.agentRef,
                        );
                        let cwd = defaultCwd;
                        if (savedDirectoryId !== null && savedDirectoryId !== defaultCwd.directoryId) {
                            try {
                                cwd = await requests.workspaceDirectory(botId, savedDirectoryId, signal);
                                signal.throwIfAborted();
                            } catch {
                                signal.throwIfAborted();
                            }
                        }
                        const ready = { kind: "ready" as const, workspace, cwd, ...result };
                        changedOptionIds.clear();
                        set({ settings: ready });
                        publishSettings(ready);
                        return;
                    }
                    await wait(signal);
                }
            } catch (cause) {
                if (!lifetimeSignal.aborted) {
                    set({
                        settings: {
                            kind: "failed",
                            message: cause instanceof Error ? cause.message : "Harness settings are unavailable.",
                        },
                    });
                }
            }
        };
        return {
            cwdBrowser: { kind: "closed" },
            settings: { kind: "loading" },
            browseCwd,
            closeCwd: () => {
                cwdOperation?.abort();
                cwdOperation = null;
                set({ cwdBrowser: { kind: "closed" } });
            },
            load,
            openCwd: () => {
                const settings = get().settings;
                if (settings.kind === "ready") {
                    set({ cwdBrowser: { kind: "ready", directory: settings.cwd, path: settings.cwd.directoryLabel } });
                }
            },
            saveCwd: async (signal) => {
                const browser = get().cwdBrowser;
                const settings = get().settings;
                if ((browser.kind !== "ready" && browser.kind !== "failed") || settings.kind !== "ready") {
                    return;
                }
                const requestedPath = browser.path.trim();
                if (requestedPath.length === 0) {
                    set({
                        cwdBrowser: {
                            kind: "failed",
                            directory: browser.directory,
                            message: "Enter a working directory path.",
                            path: browser.path,
                        },
                    });
                    return;
                }
                let directory = browser.directory;
                if (requestedPath !== browser.directory.directoryLabel) {
                    cwdOperation?.abort();
                    const operation = new AbortController();
                    cwdOperation = operation;
                    const requestSignal = AbortSignal.any([signal, operation.signal, AbortSignal.timeout(120_000)]);
                    set({ cwdBrowser: { kind: "loading", path: browser.path } });
                    try {
                        directory = await requests.workspaceDirectory(
                            botId,
                            pathDirectoryId(requestedPath),
                            requestSignal,
                        );
                        requestSignal.throwIfAborted();
                    } catch (cause) {
                        if (operation.signal.aborted) {
                            return;
                        }
                        signal.throwIfAborted();
                        set({
                            cwdBrowser: {
                                kind: "failed",
                                directory: browser.directory,
                                message: failureMessage(cause),
                                path: browser.path,
                            },
                        });
                        return;
                    } finally {
                        if (cwdOperation === operation) {
                            cwdOperation = null;
                        }
                    }
                }
                const ready = { ...settings, cwd: directory };
                set({ settings: ready, cwdBrowser: { kind: "closed" } });
                const selected = ready.workspace.selected;
                if (selected !== null) {
                    saveLastCwdPreference(storage, botId, selected.runtimeId, selected.agentRef, directory.directoryId);
                }
                publishSettings(ready);
            },
            selectHarness: async (value, disabled, signal) => {
                const settings = get().settings;
                if (settings.kind !== "ready" || disabled) {
                    return;
                }
                const agent = settings.workspace.agents.find(
                    (item) => `${item.runtimeId}:${item.agentRef}` === value && item.online,
                );
                if (agent === undefined) {
                    return;
                }
                set({ settings: { kind: "loading" } });
                onSettings(null);
                try {
                    await requests.selectAgent(
                        botId,
                        {
                            agentConfigRevision: 1,
                            agentRef: agent.agentRef,
                            runtimeId: agent.runtimeId,
                            workspaceRef: "default",
                        },
                        AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
                    );
                    signal.throwIfAborted();
                    selectedHarness = value;
                    await load(signal);
                } catch (cause) {
                    if (!signal.aborted) {
                        set({
                            settings: {
                                kind: "failed",
                                message: cause instanceof Error ? cause.message : "The harness could not be selected.",
                            },
                        });
                    }
                }
            },
            selectOption: (configId, value) => {
                const settings = get().settings;
                if (settings.kind !== "ready") {
                    return;
                }
                const ready = {
                    ...settings,
                    options: settings.options.map((option) =>
                        option.id === configId ? { ...option, currentValue: value } : option,
                    ),
                };
                changedOptionIds.add(configId);
                set({ settings: ready });
                publishSettings(ready);
            },
            toggleOption: (configId) => {
                const settings = get().settings;
                if (settings.kind !== "ready") {
                    return;
                }
                const ready = {
                    ...settings,
                    options: settings.options.map((option) =>
                        option.id === configId && option.type === "boolean"
                            ? { ...option, booleanValue: !option.booleanValue }
                            : option,
                    ),
                };
                changedOptionIds.add(configId);
                set({ settings: ready });
                publishSettings(ready);
            },
            setCwdPath: (path) => {
                const browser = get().cwdBrowser;
                if (browser.kind === "ready" || browser.kind === "failed") {
                    set({ cwdBrowser: { ...browser, path } });
                }
            },
        };
    });
