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
import { readLastHarnessPreference, saveLastHarnessPreference } from "@/services/chat/last-harness-preference";
import { pathDirectoryId } from "@/services/chat/workspace-directory-reference";
import { isRuntimeConnectionFailure } from "@/services/management/management-api";
import { formatError, runtimeDisconnectedMessage } from "../format-error.ts";

type DraftSettingsState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly message: string }
    | {
          readonly kind: "switching";
          readonly selectedHarness: string;
      }
    | {
          readonly kind: "refreshing";
          readonly selectedAgent: ChatAgentSelection;
          readonly cwd: WorkspaceEntriesEvent;
      }
    | {
          readonly kind: "ready";
          readonly selectedAgent: ChatAgentSelection;
          readonly cwd: WorkspaceEntriesEvent;
          readonly options: readonly SessionConfigOption[];
      };

type ReadyDraftSettings = Extract<DraftSettingsState, { readonly kind: "ready" }>;

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
    /** Whether the working-directory popover trigger is expanded. */
    readonly cwdMenuOpen: boolean;
    readonly recentCwds: readonly RecentCwdPreference[];
    readonly settings: DraftSettingsState;
    readonly browseCwd: (directoryId: string, signal: AbortSignal) => Promise<void>;
    readonly closeCwd: () => void;
    readonly forgetRecentCwd: (directoryId: string) => void;
    readonly load: (signal: AbortSignal) => Promise<void>;
    /**
     * The Runtime's Agents changed. A draft whose Agent the Runtime no longer offers loads again, which settles on an
     * offered Agent and withdraws the settings published for the removed one.
     */
    readonly runtimeChanged: (configuration: BotRuntimeConfiguration, signal: AbortSignal) => Promise<void>;
    readonly openCwd: () => void;
    readonly setCwdMenuOpen: (open: boolean) => void;
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
    requests: Pick<BotChatApi, "directory" | "agentSettings">,
    onSettings: (settings: ChatDraftConfiguration | null) => void,
    /** The Runtime configuration the workspace keeps current. */
    runtimeConfiguration: () => BotRuntimeConfiguration | null,
) =>
    createStore<DraftControlsStore>()((set, get) => {
        let cwdOperation: AbortController | null = null;
        // Agent settings belong to the Runtime configuration they were read under: a different configuration, as
        // after the Runtime reconnects or its Agents change, drops them.
        const agentSettings = new Map<string, Awaited<ReturnType<BotChatApi["agentSettings"]>>>();
        let settingsRuntime: string | null = null;
        // Counts the different Runtime configurations seen. A read records the one it started under; a read that
        // finishes under a newer one is neither shown nor cached, and the draft reloads against the newest.
        let configurationRevision = 0;
        const readAgentSettings = async (agentRef: string, refresh: boolean, signal: AbortSignal) => {
            const cached = refresh ? undefined : agentSettings.get(agentRef);
            if (cached !== undefined) {
                return cached;
            }
            const revision = configurationRevision;
            const result = await requests.agentSettings(botId, agentRef, signal);
            if (revision === configurationRevision) {
                agentSettings.set(agentRef, result);
            }
            return result;
        };
        // Set when the draft could not load from the Runtime as the page knows it: no connected Agent yet, or the
        // Runtime cannot be reached. `runtimeChanged` loads once the Runtime is online.
        let waitingForRuntime = false;
        /**
         * The draft cannot load while the Runtime is unreachable, whether the configuration already says so or a
         * read found out. It says why and offers Retry, and loads by itself once the Runtime is back.
         */
        const awaitRuntime = (): void => {
            waitingForRuntime = true;
            onSettings(null);
            set({ settings: { kind: "failed", message: runtimeDisconnectedMessage } });
        };
        const settleFailure = (cause: unknown, message: string): void => {
            if (isRuntimeConnectionFailure(cause)) {
                awaitRuntime();
                return;
            }
            onSettings(null);
            set({ settings: { kind: "failed", message: formatError(cause, message) } });
        };
        // Set while an explicit harness choice is being loaded. The load selects
        // that exact harness instead of falling back to another one.
        let pendingHarness: string | null = null;
        const changedOptionIds = new Set<string>();
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
            set({ settings: ready, cwdBrowser: { kind: "closed" }, recentCwds });
            publishSettings(ready);
        };
        const applyAgentSettings = (
            selectedAgent: ChatAgentSelection,
            cwd: WorkspaceEntriesEvent,
            options: readonly SessionConfigOption[],
            rememberHarness: boolean,
        ): void => {
            const restoredSettings = restoreLastAgentSettings(botId, selectedAgent.agentRef, options);
            const ready = {
                kind: "ready" as const,
                selectedAgent,
                cwd,
                options: restoredSettings.options,
            };
            changedOptionIds.clear();
            for (const configId of restoredSettings.restoredIds) {
                changedOptionIds.add(configId);
            }
            // A harness becomes the remembered default only once its settings
            // are actually applied. A fallback to another connected Agent, or
            // a load that fails, must leave the user's choice in place.
            if (rememberHarness) {
                saveLastHarnessPreference(botId, selectedAgent.agentRef);
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
            // Nothing from the previous harness may stay submittable while the
            // target harness and its settings load: a message sent in that
            // window would create a conversation on the harness being left.
            if (currentSettings.kind !== "switching") {
                set({ settings: { kind: "loading" } });
            }
            onSettings(null);
            waitingForRuntime = false;
            try {
                const requestedHarness = pendingHarness ?? readLastHarnessPreference(botId);
                const configuration = runtimeConfiguration();
                if (configuration?.runtime.online === false) {
                    awaitRuntime();
                    return;
                }
                const agents = configuration === null ? [] : connectedChatRuntimeAgents(configuration.runtime);
                const selected =
                    (requestedHarness === null
                        ? undefined
                        : agents.find((agent) => agent.agentRef === requestedHarness)) ??
                    // A remembered harness that is not connected must not
                    // block the draft; the first connected Agent stands in
                    // until the user chooses again.
                    (pendingHarness === null ? agents[0] : undefined);
                if (selected === undefined) {
                    // The Runtime the page follows offers no Agent to load yet.
                    waitingForRuntime = true;
                    return;
                }
                const revision = configurationRevision;
                const [result, defaultCwd] = await Promise.all([
                    readAgentSettings(selected.agentRef, false, signal),
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
                if (revision !== configurationRevision) {
                    await load(lifetimeSignal);
                    return;
                }
                applyAgentSettings(selected, cwd, result.options, requestedHarness === selected.agentRef);
            } catch (cause) {
                if (!lifetimeSignal.aborted) {
                    settleFailure(cause, "Harness settings are unavailable.");
                }
            }
        };
        /** Re-reads the selected Agent's settings, keeping the selection and directory while they load. */
        const refreshSettings = async (settings: ReadyDraftSettings, signal: AbortSignal): Promise<void> => {
            set({
                settings: {
                    kind: "refreshing",
                    selectedAgent: settings.selectedAgent,
                    cwd: settings.cwd,
                },
            });
            onSettings(null);
            const revision = configurationRevision;
            try {
                const result = await readAgentSettings(settings.selectedAgent.agentRef, true, signal);
                signal.throwIfAborted();
                if (revision !== configurationRevision) {
                    // The Runtime changed during the read, maybe dropping this Agent: the newest configuration decides.
                    await load(signal);
                    return;
                }
                applyAgentSettings(settings.selectedAgent, settings.cwd, result.options, false);
            } catch (cause) {
                if (!signal.aborted) {
                    settleFailure(cause, "Harness settings are unavailable.");
                }
            }
        };
        return {
            cwdBrowser: { kind: "closed" },
            cwdMenuOpen: false,
            recentCwds: readRecentCwdPreferences(botId) ?? [],
            settings: { kind: "loading" },
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
            runtimeChanged: async (configuration, signal) => {
                // Agent settings follow the Runtime configuration: a different one drops those read before it.
                const runtime = JSON.stringify(configuration.runtime);
                const changed = runtime !== settingsRuntime;
                settingsRuntime = runtime;
                if (changed) {
                    configurationRevision += 1;
                    agentSettings.clear();
                }
                // An offline Runtime offers nothing for now, which says nothing about whether the Agent was removed.
                if (!configuration.runtime.online) {
                    return;
                }
                const settings = get().settings;
                switch (settings.kind) {
                    case "loading":
                        // A load in flight sees the newer revision when it finishes and reloads against it.
                        if (waitingForRuntime) {
                            await load(signal);
                        }
                        return;
                    case "failed":
                        if (waitingForRuntime || changed) {
                            await load(signal);
                        }
                        return;
                    case "refreshing":
                    case "switching":
                        // The read in flight sees the newer revision when it finishes and reloads against it.
                        return;
                    case "ready": {
                        const offered = connectedChatRuntimeAgents(configuration.runtime).some(
                            (agent) =>
                                agent.runtimeId === settings.selectedAgent.runtimeId &&
                                agent.agentRef === settings.selectedAgent.agentRef,
                        );
                        if (!offered) {
                            await load(signal);
                        } else if (changed) {
                            await refreshSettings(settings, signal);
                        }
                        return;
                    }
                }
            },
            openCwd: () => {
                const settings = get().settings;
                if (settings.kind === "ready") {
                    set({ cwdBrowser: { kind: "ready", directory: settings.cwd, path: settings.cwd.directoryLabel } });
                }
            },
            setCwdMenuOpen: (open) => set({ cwdMenuOpen: open }),
            refreshAgentSettings: async (signal) => {
                const settings = get().settings;
                if (settings.kind === "ready") {
                    await refreshSettings(settings, signal);
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
                // The Runtime's Agents can change while the draft is open; choose among those it offers now.
                const configuration = runtimeConfiguration();
                const agent = (configuration === null ? [] : connectedChatRuntimeAgents(configuration.runtime)).find(
                    (item) => `${item.runtimeId}:${item.agentRef}` === value,
                );
                if (agent === undefined) {
                    return;
                }
                pendingHarness = agent.agentRef;
                set({ settings: { kind: "switching", selectedHarness: value } });
                onSettings(null);
                try {
                    await load(signal);
                } catch (cause) {
                    if (!signal.aborted) {
                        onSettings(null);
                        set({
                            settings: {
                                kind: "failed",
                                message: formatError(cause, "The harness could not be selected."),
                            },
                        });
                    }
                } finally {
                    if (pendingHarness === agent.agentRef) {
                        pendingHarness = null;
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
