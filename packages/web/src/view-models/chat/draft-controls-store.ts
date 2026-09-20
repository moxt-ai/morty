import type { SessionConfigOption, WorkspaceEntriesEvent } from "@moxt-ai/mobius-protocol";
import { createStore } from "zustand/vanilla";
import type { BotChatApi, ChatDraftConfiguration, ChatWorkspace } from "@/services/chat/bot-chat-api";
import {
    forgetRecentCwdPreference,
    type RecentCwdPreference,
    readLastCwdPreference,
    readRecentCwdPreferences,
    saveLastCwdPreference,
    saveRecentCwdPreference,
} from "@/services/chat/last-cwd-preference";

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
    | { readonly kind: "loading"; readonly directory: WorkspaceEntriesEvent; readonly path: string }
    | { readonly kind: "ready"; readonly directory: WorkspaceEntriesEvent; readonly path: string }
    | {
          readonly kind: "failed";
          readonly directory: WorkspaceEntriesEvent;
          readonly message: string;
          readonly path: string;
      };

export interface DraftControlsStore {
    readonly cwdBrowser: CwdBrowserState;
    readonly recentCwds: readonly RecentCwdPreference[];
    readonly settings: DraftSettingsState;
    readonly browseCwd: (directoryId: string, signal: AbortSignal) => Promise<void>;
    readonly closeCwd: () => void;
    readonly forgetRecentCwd: (directoryId: string) => void;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly openCwd: () => void;
    readonly saveCwd: (signal: AbortSignal) => Promise<void>;
    readonly selectRecentCwd: (directoryId: string, signal: AbortSignal) => Promise<void>;
    readonly selectHarness: (value: string, disabled: boolean, signal: AbortSignal) => Promise<void>;
    readonly selectOption: (configId: string, value: string) => void;
    readonly setCwdPath: (path: string, signal: AbortSignal) => void;
}

const CWD_PREVIEW_DEBOUNCE_MILLISECONDS = 1_000;

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

function waitForCwdPreview(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const timeout = window.setTimeout(finish, CWD_PREVIEW_DEBOUNCE_MILLISECONDS);
        function finish(): void {
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", cancel);
            resolve();
        }
        function cancel(): void {
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", cancel);
            reject(signal.reason);
        }
        signal.addEventListener("abort", cancel, { once: true });
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
        const publishSettings = (settings: Extract<DraftSettingsState, { readonly kind: "ready" }>): void => {
            const model = settings.options.find((option) => option.category === "model" && option.type !== "boolean");
            const permission = settings.options.find(
                (option) => option.category === "_mobius_permission" && option.type !== "boolean",
            );
            onSettings(
                model === undefined || permission === undefined
                    ? null
                    : {
                          bindingId: settings.bindingId,
                          permissionMode: permission.currentValue,
                          workspaceRef: settings.cwd.directoryId,
                          workspaceLabel: settings.cwd.directoryLabel,
                          configuration: {
                              additionalDirectoryIds: [],
                              booleanValue: false,
                              configId: model.id,
                              value: model.currentValue,
                              valueType: "select",
                          },
                      },
            );
        };
        const rememberDirectory = (
            settings: Extract<DraftSettingsState, { readonly kind: "ready" }>,
            directory: WorkspaceEntriesEvent,
        ): readonly RecentCwdPreference[] => {
            const selected = settings.workspace.selected;
            if (selected === null) {
                return get().recentCwds;
            }
            saveLastCwdPreference(storage, botId, selected.runtimeId, selected.agentRef, directory.directoryId);
            return saveRecentCwdPreference(
                storage,
                botId,
                selected.runtimeId,
                selected.agentRef,
                { directoryId: directory.directoryId, directoryLabel: directory.directoryLabel },
                get().recentCwds,
            );
        };
        const applyDirectory = (
            settings: Extract<DraftSettingsState, { readonly kind: "ready" }>,
            directory: WorkspaceEntriesEvent,
        ): void => {
            const ready = { ...settings, cwd: directory };
            const recentCwds = rememberDirectory(ready, directory);
            set({ settings: ready, cwdBrowser: { kind: "closed" }, recentCwds });
            publishSettings(ready);
        };
        const browseCwd = async (directoryId: string, lifetimeSignal: AbortSignal): Promise<void> => {
            const settings = get().settings;
            if (settings.kind !== "ready") {
                return;
            }
            const currentBrowser = get().cwdBrowser;
            const previousPath = currentBrowser.kind === "closed" ? settings.cwd.directoryLabel : currentBrowser.path;
            const previousDirectory = currentBrowser.kind === "closed" ? settings.cwd : currentBrowser.directory;
            cwdOperation?.abort();
            const operation = new AbortController();
            cwdOperation = operation;
            const signal = AbortSignal.any([lifetimeSignal, operation.signal, AbortSignal.timeout(120_000)]);
            set({ cwdBrowser: { kind: "loading", directory: previousDirectory, path: previousPath } });
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
        const previewCwd = async (path: string, lifetimeSignal: AbortSignal): Promise<void> => {
            const browser = get().cwdBrowser;
            if (browser.kind === "closed") {
                return;
            }
            cwdOperation?.abort();
            const operation = new AbortController();
            cwdOperation = operation;
            const signal = AbortSignal.any([lifetimeSignal, operation.signal, AbortSignal.timeout(120_000)]);
            try {
                await waitForCwdPreview(signal);
                const requestedPath = path.trim();
                if (requestedPath.length === 0) {
                    set({
                        cwdBrowser: {
                            kind: "failed",
                            directory: browser.directory,
                            message: "Enter a working directory path.",
                            path,
                        },
                    });
                    return;
                }
                set({ cwdBrowser: { kind: "loading", directory: browser.directory, path } });
                const directory = await requests.workspaceDirectory(botId, pathDirectoryId(requestedPath), signal);
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
                        directory: browser.directory,
                        message: failureMessage(cause),
                        path,
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
                        const existingRecentCwds = readRecentCwdPreferences(
                            storage,
                            botId,
                            selected.runtimeId,
                            selected.agentRef,
                        );
                        saveLastCwdPreference(storage, botId, selected.runtimeId, selected.agentRef, cwd.directoryId);
                        const recentCwds =
                            existingRecentCwds === null
                                ? saveRecentCwdPreference(
                                      storage,
                                      botId,
                                      selected.runtimeId,
                                      selected.agentRef,
                                      { directoryId: cwd.directoryId, directoryLabel: cwd.directoryLabel },
                                      [],
                                  )
                                : existingRecentCwds;
                        set({ settings: ready, recentCwds });
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
            recentCwds: [],
            settings: { kind: "loading" },
            browseCwd,
            closeCwd: () => {
                cwdOperation?.abort();
                cwdOperation = null;
                set({ cwdBrowser: { kind: "closed" } });
            },
            forgetRecentCwd: (directoryId) => {
                const settings = get().settings;
                const selected = settings.kind === "ready" ? settings.workspace.selected : null;
                const recentCwds = get().recentCwds;
                if (selected === null || !recentCwds.some((directory) => directory.directoryId === directoryId)) {
                    return;
                }
                set({
                    recentCwds: forgetRecentCwdPreference(
                        storage,
                        botId,
                        selected.runtimeId,
                        selected.agentRef,
                        directoryId,
                        recentCwds,
                    ),
                });
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
                if (browser.kind === "closed" || settings.kind !== "ready") {
                    return;
                }
                cwdOperation?.abort();
                cwdOperation = null;
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
                    const operation = new AbortController();
                    cwdOperation = operation;
                    const requestSignal = AbortSignal.any([signal, operation.signal, AbortSignal.timeout(120_000)]);
                    set({ cwdBrowser: { kind: "loading", directory: browser.directory, path: browser.path } });
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
                applyDirectory(settings, directory);
            },
            selectRecentCwd: async (directoryId, signal) => {
                const settings = get().settings;
                const recent = get().recentCwds.find((directory) => directory.directoryId === directoryId);
                if (settings.kind !== "ready" || recent === undefined) {
                    return;
                }
                cwdOperation?.abort();
                const operation = new AbortController();
                cwdOperation = operation;
                const requestSignal = AbortSignal.any([signal, operation.signal, AbortSignal.timeout(120_000)]);
                try {
                    const directory = await requests.workspaceDirectory(botId, directoryId, requestSignal);
                    requestSignal.throwIfAborted();
                    applyDirectory(settings, directory);
                } catch (cause) {
                    if (operation.signal.aborted) {
                        return;
                    }
                    signal.throwIfAborted();
                    set({
                        cwdBrowser: {
                            kind: "failed",
                            directory: settings.cwd,
                            message: failureMessage(cause),
                            path: recent.directoryLabel,
                        },
                    });
                } finally {
                    if (cwdOperation === operation) {
                        cwdOperation = null;
                    }
                }
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
                set({ settings: ready });
                publishSettings(ready);
            },
            setCwdPath: (path, signal) => {
                const browser = get().cwdBrowser;
                if (browser.kind !== "closed") {
                    cwdOperation?.abort();
                    cwdOperation = null;
                    set({ cwdBrowser: { kind: "ready", directory: browser.directory, path } });
                    void previewCwd(path, signal);
                }
            },
        };
    });
