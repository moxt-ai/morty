import type { SessionConfigOption, WorkspaceEntriesEvent } from "@moxt-ai/mobius-sdk/protocol";
import { createStore } from "zustand/vanilla";
import {
    type BotChatApi,
    type BotRuntimeConfiguration,
    type ChatAgentSelection,
    type ChatDraftConfiguration,
    connectedChatRuntimeAgents,
} from "@/services/chat/bot-chat-api";
import { restoreLastAgentSettings, saveLastAgentSettings } from "@/services/chat/last-agent-settings";
import {
    forgetRecentCwdPreference,
    type RecentCwdPreference,
    readLastCwdPreference,
    readRecentCwdPreferences,
    saveLastCwdPreference,
    saveRecentCwdPreference,
} from "@/services/chat/last-cwd-preference";
import { pathDirectoryId } from "@/services/chat/workspace-directory-reference";
import { formatError } from "../format-error.ts";

type DraftSettingsState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly message: string }
    | {
          readonly kind: "switching";
          readonly selectedHarness: string;
          readonly configuration: BotRuntimeConfiguration;
      }
    | {
          readonly kind: "refreshing";
          readonly configuration: BotRuntimeConfiguration;
          readonly selectedAgent: ChatAgentSelection;
          readonly cwd: WorkspaceEntriesEvent;
      }
    | {
          readonly kind: "ready";
          readonly configuration: BotRuntimeConfiguration;
          readonly selectedAgent: ChatAgentSelection;
          readonly cwd: WorkspaceEntriesEvent;
          readonly options: readonly SessionConfigOption[];
      };

type ReadyDraftSettings = Extract<DraftSettingsState, { readonly kind: "ready" }>;

const draftSettingsCache = new WeakMap<object, Map<string, ReadyDraftSettings>>();

function cacheDraftSettings(requests: object, botId: string, settings: ReadyDraftSettings): void {
    const existing = draftSettingsCache.get(requests);
    if (existing === undefined) {
        draftSettingsCache.set(requests, new Map([[botId, settings]]));
        return;
    }
    existing.set(botId, settings);
}

type CwdBrowserState =
    | { readonly kind: "closed" }
    | { readonly kind: "loading"; readonly directory: WorkspaceEntriesEvent; readonly path: string }
    | { readonly kind: "previewing"; readonly directory: WorkspaceEntriesEvent; readonly path: string }
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
    readonly refreshAgentSettings: (signal: AbortSignal) => Promise<void>;
    readonly saveCwd: (signal: AbortSignal) => Promise<void>;
    readonly selectRecentCwd: (directoryId: string, signal: AbortSignal) => Promise<void>;
    readonly selectHarness: (value: string, disabled: boolean, signal: AbortSignal) => Promise<void>;
    readonly selectOption: (configId: string, value: string) => void;
    readonly toggleOption: (configId: string) => void;
    readonly setCwdPath: (path: string, signal: AbortSignal) => void;
}

const CWD_PREVIEW_DEBOUNCE_MILLISECONDS = 1_000;

function failureMessage(cause: unknown): string {
    return formatError(cause, "The working directory is unavailable.");
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
    requests: Pick<BotChatApi, "runtimeConfiguration" | "directory" | "agentSettings">,
    onSettings: (settings: ChatDraftConfiguration | null) => void,
) =>
    createStore<DraftControlsStore>()((set, get) => {
        const cachedSettings = draftSettingsCache.get(requests)?.get(botId);
        let cwdOperation: AbortController | null = null;
        let selectedHarness =
            cachedSettings === undefined
                ? ""
                : `${cachedSettings.selectedAgent.runtimeId}:${cachedSettings.selectedAgent.agentRef}`;
        const changedOptionIds = new Set(
            cachedSettings === undefined
                ? []
                : restoreLastAgentSettings(botId, cachedSettings.selectedAgent.agentRef, cachedSettings.options)
                      .restoredIds,
        );
        const rememberAgentSettings = (settings: ReadyDraftSettings): void => {
            saveLastAgentSettings(botId, settings.selectedAgent.agentRef, settings.options);
        };
        const publishSettings = (settings: ReadyDraftSettings): void => {
            onSettings({
                agentRef: settings.selectedAgent.agentRef,
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
        const rememberDirectory = (
            settings: ReadyDraftSettings,
            directory: WorkspaceEntriesEvent,
        ): readonly RecentCwdPreference[] => {
            const selected = settings.selectedAgent;
            saveLastCwdPreference(botId, selected.runtimeId, selected.agentRef, directory.directoryId);
            return saveRecentCwdPreference(
                botId,
                { directoryId: directory.directoryId, directoryLabel: directory.directoryLabel },
                get().recentCwds,
            );
        };
        const applyDirectory = (settings: ReadyDraftSettings, directory: WorkspaceEntriesEvent): void => {
            const ready = { ...settings, cwd: directory };
            const recentCwds = rememberDirectory(ready, directory);
            cacheDraftSettings(requests, botId, ready);
            set({ settings: ready, cwdBrowser: { kind: "closed" }, recentCwds });
            publishSettings(ready);
        };
        const applyAgentSettings = (
            configuration: BotRuntimeConfiguration,
            selectedAgent: ChatAgentSelection,
            cwd: WorkspaceEntriesEvent,
            options: readonly SessionConfigOption[],
        ): void => {
            const restoredSettings = restoreLastAgentSettings(botId, selectedAgent.agentRef, options);
            const ready = {
                kind: "ready" as const,
                configuration,
                selectedAgent,
                cwd,
                options: restoredSettings.options,
            };
            changedOptionIds.clear();
            for (const configId of restoredSettings.restoredIds) {
                changedOptionIds.add(configId);
            }
            const existingRecentCwds = readRecentCwdPreferences(botId);
            saveLastCwdPreference(botId, selectedAgent.runtimeId, selectedAgent.agentRef, cwd.directoryId);
            const recentCwds =
                existingRecentCwds === null
                    ? saveRecentCwdPreference(
                          botId,
                          { directoryId: cwd.directoryId, directoryLabel: cwd.directoryLabel },
                          [],
                      )
                    : existingRecentCwds;
            cacheDraftSettings(requests, botId, ready);
            set({ settings: ready, recentCwds });
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
                const directory = await requests.directory(botId, directoryId, signal);
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
                const directory = await requests.directory(botId, pathDirectoryId(requestedPath), signal);
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
            const currentSettings = get().settings;
            if (currentSettings.kind === "ready") {
                publishSettings(currentSettings);
            } else {
                onSettings(null);
            }
            if (currentSettings.kind !== "ready" && currentSettings.kind !== "switching") {
                set({ settings: { kind: "loading" } });
            }
            try {
                while (!signal.aborted) {
                    const configuration = await requests.runtimeConfiguration(botId, signal);
                    const selected = connectedChatRuntimeAgents(configuration.runtime).find(
                        (agent) => selectedHarness === "" || `${agent.runtimeId}:${agent.agentRef}` === selectedHarness,
                    );
                    if (selected !== undefined) {
                        const [result, defaultCwd] = await Promise.all([
                            requests.agentSettings(botId, selected.agentRef, false, signal),
                            requests.directory(botId, "default", signal),
                        ]);
                        signal.throwIfAborted();
                        const savedDirectoryId = readLastCwdPreference(botId, selected.runtimeId, selected.agentRef);
                        let cwd = defaultCwd;
                        if (savedDirectoryId !== null && savedDirectoryId !== defaultCwd.directoryId) {
                            try {
                                cwd = await requests.directory(botId, savedDirectoryId, signal);
                                signal.throwIfAborted();
                            } catch {
                                signal.throwIfAborted();
                            }
                        }
                        applyAgentSettings(configuration, selected, cwd, result.options);
                        return;
                    }
                    await wait(signal);
                }
            } catch (cause) {
                if (!lifetimeSignal.aborted) {
                    set({
                        settings: {
                            kind: "failed",
                            message: formatError(cause, "Harness settings are unavailable."),
                        },
                    });
                }
            }
        };
        return {
            cwdBrowser: { kind: "closed" },
            recentCwds: readRecentCwdPreferences(botId) ?? [],
            settings: cachedSettings ?? { kind: "loading" },
            browseCwd,
            closeCwd: () => {
                cwdOperation?.abort();
                cwdOperation = null;
                set({ cwdBrowser: { kind: "closed" } });
            },
            forgetRecentCwd: (directoryId) => {
                const settings = get().settings;
                const selected = settings.kind === "ready" ? settings.selectedAgent : null;
                const recentCwds = get().recentCwds;
                if (selected === null || !recentCwds.some((directory) => directory.directoryId === directoryId)) {
                    return;
                }
                set({
                    recentCwds: forgetRecentCwdPreference(botId, directoryId, recentCwds),
                });
            },
            load,
            openCwd: () => {
                const settings = get().settings;
                if (settings.kind === "ready") {
                    set({ cwdBrowser: { kind: "ready", directory: settings.cwd, path: settings.cwd.directoryLabel } });
                }
            },
            refreshAgentSettings: async (signal) => {
                const settings = get().settings;
                if (settings.kind !== "ready") {
                    return;
                }
                set({
                    settings: {
                        kind: "refreshing",
                        configuration: settings.configuration,
                        selectedAgent: settings.selectedAgent,
                        cwd: settings.cwd,
                    },
                });
                onSettings(null);
                try {
                    const result = await requests.agentSettings(botId, settings.selectedAgent.agentRef, true, signal);
                    signal.throwIfAborted();
                    applyAgentSettings(settings.configuration, settings.selectedAgent, settings.cwd, result.options);
                } catch (cause) {
                    if (!signal.aborted) {
                        set({
                            settings: {
                                kind: "failed",
                                message: formatError(cause, "Harness settings are unavailable."),
                            },
                        });
                    }
                }
            },
            saveCwd: async (signal) => {
                const browser = get().cwdBrowser;
                const settings = get().settings;
                if (
                    browser.kind === "closed" ||
                    browser.kind === "loading" ||
                    browser.kind === "previewing" ||
                    settings.kind !== "ready"
                ) {
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
                        directory = await requests.directory(botId, pathDirectoryId(requestedPath), requestSignal);
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
                    const directory = await requests.directory(botId, directoryId, requestSignal);
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
                const agent = connectedChatRuntimeAgents(settings.configuration.runtime).find(
                    (item) => `${item.runtimeId}:${item.agentRef}` === value,
                );
                if (agent === undefined) {
                    return;
                }
                selectedHarness = value;
                set({ settings: { kind: "switching", selectedHarness: value, configuration: settings.configuration } });
                onSettings(null);
                try {
                    await load(signal);
                } catch (cause) {
                    if (!signal.aborted) {
                        selectedHarness = "";
                        set({
                            settings: {
                                kind: "failed",
                                message: formatError(cause, "The harness could not be selected."),
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
                rememberAgentSettings(ready);
                cacheDraftSettings(requests, botId, ready);
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
                rememberAgentSettings(ready);
                cacheDraftSettings(requests, botId, ready);
                set({ settings: ready });
                publishSettings(ready);
            },
            setCwdPath: (path, signal) => {
                const browser = get().cwdBrowser;
                if (browser.kind !== "closed") {
                    cwdOperation?.abort();
                    cwdOperation = null;
                    set({ cwdBrowser: { kind: "previewing", directory: browser.directory, path } });
                    void previewCwd(path, signal);
                }
            },
        };
    });
