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
import type { AgentModelCatalog } from "../../services/diagnostics/model-catalog.ts";
import { formatError } from "../format-error.ts";
import { harnessOptions, nativeSessionAgentTabs } from "./native-session-agents.ts";

type DraftSettingsState =
    | { readonly kind: "loading" }
    | { readonly kind: "waiting-agent" }
    | { readonly kind: "waiting-runtime" }
    | { readonly kind: "failed"; readonly message: string }
    | {
          readonly kind: "switching";
          readonly agentRef: string;
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
          readonly catalog: AgentModelCatalog;
          /** Explicit or restored choices must be sent even when their values equal the Agent defaults. */
          readonly changedOptionIds: ReadonlySet<string>;
      };

type ReadyDraftSettings = Extract<DraftSettingsState, { readonly kind: "ready" }>;

export function draftHarnessSelection(settings: DraftSettingsState, configuration: BotRuntimeConfiguration | null) {
    const options = harnessOptions(configuration?.runtime ?? null);
    const agentRef =
        settings.kind === "switching"
            ? settings.agentRef
            : settings.kind === "ready" || settings.kind === "refreshing"
              ? settings.selectedAgent.agentRef
              : null;
    return { options, value: options.find((option) => option.agentRef === agentRef)?.value ?? "" };
}

export function draftConfiguration(settings: DraftSettingsState): ChatDraftConfiguration | null {
    if (settings.kind !== "ready") {
        return null;
    }
    return {
        agentRef: settings.selectedAgent.agentRef,
        workspaceRef: settings.cwd.directoryId,
        workspaceLabel: settings.cwd.directoryLabel,
        configurations: settings.options
            .filter((option) => option.category === "model" || settings.changedOptionIds.has(option.id))
            .map((option) => ({
                booleanValue: option.type === "boolean" ? option.booleanValue : false,
                configId: option.id,
                value: option.type === "select" ? option.currentValue : "",
                valueType: option.type,
            })),
    };
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
     * offered Agent and drops the settings for the removed one.
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
    /** The Runtime configuration the workspace keeps current. */
    runtimeConfiguration: () => BotRuntimeConfiguration | null,
    onWaitingForRuntime: () => void,
) =>
    createStore<DraftControlsStore>()((set, get) => {
        let cwdOperation: AbortController | null = null;
        // Agent settings belong to the Runtime configuration they were read under: a different configuration, as
        // after the Runtime reconnects or its Agents change, drops them. They also belong to the directory a Session
        // would start in, whose project settings the Agent reads.
        const agentSettings = new Map<string, Awaited<ReturnType<BotChatApi["agentSettings"]>>>();
        let settingsRuntime: string | null = null;
        // Every operation that writes the draft's settings (a load, a refresh, a harness switch, a directory choice)
        // takes this one lane: starting one stops the previous, and only the newest may write. A Runtime
        // configuration change starts its own, so nothing read under an older configuration is shown or cached.
        let settingsOperation: AbortController | null = null;
        const beginSettingsOperation = (parent: AbortSignal) => {
            settingsOperation?.abort(new Error("A newer draft settings operation started."));
            const controller = new AbortController();
            settingsOperation = controller;
            return {
                signal: AbortSignal.any([parent, controller.signal, AbortSignal.timeout(120_000)]),
                current: (): boolean => settingsOperation === controller,
            };
        };
        type SettingsOperation = ReturnType<typeof beginSettingsOperation>;
        const readAgentSettings = async (
            agentRef: string,
            cwd: WorkspaceEntriesEvent,
            refresh: boolean,
            operation: SettingsOperation,
        ) => {
            const key = JSON.stringify([agentRef, cwd.directoryId]);
            const cached = refresh ? undefined : agentSettings.get(key);
            if (cached !== undefined) {
                return cached;
            }
            const result = await requests.agentSettings(botId, agentRef, cwd.directoryId, operation.signal);
            if (operation.current()) {
                agentSettings.set(key, result);
            }
            return result;
        };
        /**
         * A directory choice writes the draft's settings and belongs to the directory browser, so it takes both
         * lanes: a newer settings operation supersedes it, and closing, editing or browsing directories cancels it.
         * It may write only while it is current in both.
         */
        const beginDirectoryChoice = (parent: AbortSignal) => {
            cwdOperation?.abort();
            const browsing = new AbortController();
            cwdOperation = browsing;
            const settings = beginSettingsOperation(parent);
            return {
                signal: AbortSignal.any([settings.signal, browsing.signal]),
                current: (): boolean => settings.current() && cwdOperation === browsing,
                release: (): void => {
                    if (cwdOperation === browsing) {
                        cwdOperation = null;
                    }
                },
            };
        };
        /**
         * The draft cannot load while the Runtime is unreachable, whether the configuration already says so or a
         * read found out. It says why and offers Retry, and loads by itself once the Runtime is back.
         */
        const awaitRuntime = (): void => {
            set({ settings: { kind: "waiting-runtime" } });
            onWaitingForRuntime();
        };
        /** Waits for the Runtime to offer an Agent, settling any switch in progress so `runtimeChanged` can resume. */
        const awaitAgent = (): void => {
            set({ settings: { kind: "waiting-agent" } });
        };
        const settleFailure = (cause: unknown, message: string): void => {
            if (isRuntimeConnectionFailure(cause)) {
                awaitRuntime();
                return;
            }
            set({ settings: { kind: "failed", message: formatError(cause, message) } });
        };
        const rememberAgentSettings = (settings: ReadyDraftSettings): void => {
            saveLastAgentSettings(botId, settings.selectedAgent.agentRef, settings.options);
        };
        const rememberDirectory = (
            settings: ReadyDraftSettings,
            directory: WorkspaceEntriesEvent,
        ): readonly RecentCwdPreference[] => {
            const selected = settings.selectedAgent;
            saveLastCwdPreference(botId, selected.runtimeId, selected.agentRef, directory.directoryId);
            return saveRecentCwdPreference(botId, {
                directoryId: directory.directoryId,
                directoryLabel: directory.directoryLabel,
            });
        };
        /** A new directory brings its own Agent settings, read while the draft keeps its selection. */
        const applyDirectory = async (
            settings: ReadyDraftSettings,
            directory: WorkspaceEntriesEvent,
            signal: AbortSignal,
        ): Promise<void> => {
            const recentCwds = rememberDirectory(settings, directory);
            set({ cwdBrowser: { kind: "closed" }, recentCwds });
            await refreshSettings({ selectedAgent: settings.selectedAgent, cwd: directory }, false, signal);
        };
        const applyAgentSettings = (
            selectedAgent: ChatAgentSelection,
            cwd: WorkspaceEntriesEvent,
            result: Awaited<ReturnType<BotChatApi["agentSettings"]>>,
            rememberHarness: boolean,
        ): void => {
            const restoredSettings = restoreLastAgentSettings(botId, selectedAgent.agentRef, result.options);
            const ready = {
                kind: "ready" as const,
                selectedAgent,
                cwd,
                options: restoredSettings.options,
                catalog: result.catalog,
                changedOptionIds: restoredSettings.restoredIds,
            };
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
                    ? saveRecentCwdPreference(botId, {
                          directoryId: cwd.directoryId,
                          directoryLabel: cwd.directoryLabel,
                      })
                    : existingRecentCwds;
            set({ settings: ready, recentCwds });
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
            const operation = beginSettingsOperation(lifetimeSignal);
            const currentSettings = get().settings;
            // Nothing from the previous harness may stay submittable while the
            // target harness and its settings load: a message sent in that
            // window would create a conversation on the harness being left.
            if (currentSettings.kind !== "switching") {
                set({ settings: { kind: "loading" } });
            }
            try {
                const switching = currentSettings.kind === "switching";
                const requestedHarness = switching ? currentSettings.agentRef : readLastHarnessPreference(botId);
                const configuration = runtimeConfiguration();
                if (configuration?.runtime.online === false) {
                    awaitRuntime();
                    return;
                }
                const agents = configuration === null ? [] : connectedChatRuntimeAgents(configuration.runtime);
                // A requested harness the Runtime does not offer must not block the draft; the first connected Agent
                // stands in until the user chooses again.
                const requestedAgent = agents.find((agent) => agent.agentRef === requestedHarness);
                const selected = requestedAgent ?? agents[0];
                if (selected === undefined) {
                    // The Runtime the page follows offers no Agent to load yet.
                    awaitAgent();
                    return;
                }
                const defaultCwd = await requests.directory(botId, "default", operation.signal);
                operation.signal.throwIfAborted();
                const savedDirectoryId = readLastCwdPreference(botId, selected.runtimeId, selected.agentRef);
                let cwd = defaultCwd;
                if (savedDirectoryId !== null && savedDirectoryId !== defaultCwd.directoryId) {
                    try {
                        cwd = await requests.directory(botId, savedDirectoryId, operation.signal);
                        operation.signal.throwIfAborted();
                    } catch {
                        operation.signal.throwIfAborted();
                    }
                }
                // The settings are read in the directory the Session would start in. A deliberate Agent switch must
                // be acknowledged by the live Runtime, not satisfied by settings cached before the user made the choice.
                const result = await readAgentSettings(selected.agentRef, cwd, switching, operation);
                operation.signal.throwIfAborted();
                if (!operation.current()) {
                    return;
                }
                // The Runtime can drop while these reads are in flight. A switch
                // that never lands must not become the remembered harness.
                const live = runtimeConfiguration();
                if (live === null || live.runtime.online === false) {
                    awaitRuntime();
                    return;
                }
                // Applying the settings and remembering the choice settle together, without an asynchronous gap.
                // A failed, cancelled, superseded or offline switch never changes the remembered preference.
                applyAgentSettings(selected, cwd, result, requestedAgent !== undefined);
            } catch (cause) {
                if (!lifetimeSignal.aborted && operation.current()) {
                    settleFailure(cause, "Harness settings are unavailable.");
                }
            }
        };
        /** Reads the selected Agent's settings in the directory, keeping the selection and directory while they load. */
        const refreshSettings = async (
            settings: Pick<ReadyDraftSettings, "cwd" | "selectedAgent">,
            refresh: boolean,
            parent: AbortSignal,
        ): Promise<void> => {
            const operation = beginSettingsOperation(parent);
            set({
                settings: {
                    kind: "refreshing",
                    selectedAgent: settings.selectedAgent,
                    cwd: settings.cwd,
                },
            });
            try {
                const result = await readAgentSettings(
                    settings.selectedAgent.agentRef,
                    settings.cwd,
                    refresh,
                    operation,
                );
                operation.signal.throwIfAborted();
                if (operation.current()) {
                    applyAgentSettings(settings.selectedAgent, settings.cwd, result, false);
                }
            } catch (cause) {
                if (!parent.aborted && operation.current()) {
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
                set({ recentCwds: forgetRecentCwdPreference(botId, directoryId) });
            },
            load,
            runtimeChanged: async (configuration, signal) => {
                // Agent settings follow the Runtime configuration: a different one drops those read before it.
                const runtime = JSON.stringify(configuration.runtime);
                const changed = runtime !== settingsRuntime;
                settingsRuntime = runtime;
                if (changed) {
                    agentSettings.clear();
                }
                // An offline Runtime offers nothing for now, which says nothing about whether the Agent was removed.
                // A harness switch still in flight has to stop here, or its late response would be remembered.
                if (!configuration.runtime.online) {
                    if (get().settings.kind === "switching") {
                        settingsOperation?.abort(new Error("The Runtime went offline."));
                        settingsOperation = null;
                        awaitRuntime();
                    }
                    return;
                }
                const settings = get().settings;
                if (!changed && settings.kind !== "waiting-runtime" && settings.kind !== "waiting-agent") {
                    return;
                }
                // Reconcile with this configuration. The new operation supersedes any read still in flight.
                const selectedAgent =
                    settings.kind === "ready" || settings.kind === "refreshing" ? settings.selectedAgent : null;
                const offered =
                    selectedAgent !== null &&
                    connectedChatRuntimeAgents(configuration.runtime).some(
                        (agent) =>
                            agent.runtimeId === selectedAgent.runtimeId && agent.agentRef === selectedAgent.agentRef,
                    );
                if (offered && (settings.kind === "ready" || settings.kind === "refreshing")) {
                    await refreshSettings(settings, true, signal);
                    return;
                }
                await load(signal);
            },
            openCwd: () => {
                const settings = get().settings;
                if (settings.kind === "ready") {
                    set({ cwdBrowser: { kind: "ready", directory: settings.cwd, path: settings.cwd.directoryLabel } });
                }
            },
            // The menu shows the recent directories as storage holds them now, including another tab's changes.
            setCwdMenuOpen: (open) =>
                set(
                    open
                        ? { cwdMenuOpen: true, recentCwds: readRecentCwdPreferences(botId) ?? [] }
                        : { cwdMenuOpen: false },
                ),
            refreshAgentSettings: async (signal) => {
                const settings = get().settings;
                if (settings.kind === "ready") {
                    await refreshSettings(settings, true, signal);
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
                const requestedPath = browser.path.trim();
                if (requestedPath.length === 0) {
                    cwdOperation?.abort();
                    cwdOperation = null;
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
                const operation = beginDirectoryChoice(signal);
                let directory = browser.directory;
                if (requestedPath !== browser.directory.directoryLabel) {
                    const loading = { kind: "loading", directory: browser.directory, path: browser.path } as const;
                    set({ cwdBrowser: loading });
                    try {
                        directory = await requests.directory(botId, pathDirectoryId(requestedPath), operation.signal);
                        operation.signal.throwIfAborted();
                    } catch (cause) {
                        if (signal.aborted) {
                            return;
                        }
                        if (!operation.current()) {
                            // Cancelled or superseded: undo only this choice's own loading state.
                            if (get().cwdBrowser === loading) {
                                set({ cwdBrowser: browser });
                            }
                            return;
                        }
                        operation.release();
                        set({
                            cwdBrowser: {
                                kind: "failed",
                                directory: browser.directory,
                                message: failureMessage(cause),
                                path: browser.path,
                            },
                        });
                        return;
                    }
                }
                if (operation.current()) {
                    operation.release();
                    await applyDirectory(settings, directory, signal);
                }
            },
            selectRecentCwd: async (directoryId, signal) => {
                const settings = get().settings;
                const recent = get().recentCwds.find((directory) => directory.directoryId === directoryId);
                if (settings.kind !== "ready" || recent === undefined) {
                    return;
                }
                const operation = beginDirectoryChoice(signal);
                try {
                    const directory = await requests.directory(botId, directoryId, operation.signal);
                    operation.signal.throwIfAborted();
                    if (operation.current()) {
                        operation.release();
                        await applyDirectory(settings, directory, signal);
                    }
                } catch (cause) {
                    if (signal.aborted || !operation.current()) {
                        return;
                    }
                    operation.release();
                    set({
                        cwdBrowser: {
                            kind: "failed",
                            directory: settings.cwd,
                            message: failureMessage(cause),
                            path: recent.directoryLabel,
                        },
                    });
                }
            },
            selectHarness: async (value, disabled, signal) => {
                const settings = get().settings;
                if (settings.kind !== "ready" || disabled) {
                    return;
                }
                // The Runtime's Agents can change while the draft is open; choose among those it offers now.
                const configuration = runtimeConfiguration();
                const agent = (configuration === null ? [] : nativeSessionAgentTabs(configuration.runtime)).find(
                    (item) => item.installed && item.value === value,
                );
                if (agent === undefined) {
                    return;
                }
                set({ settings: { kind: "switching", agentRef: agent.agentRef } });
                await load(signal);
            },
            selectOption: (configId, value) => {
                const settings = get().settings;
                if (settings.kind !== "ready") {
                    return;
                }
                const ready = {
                    ...settings,
                    changedOptionIds: new Set([...settings.changedOptionIds, configId]),
                    options: settings.options.map((option) =>
                        option.id === configId ? { ...option, currentValue: value } : option,
                    ),
                };
                rememberAgentSettings(ready);
                set({ settings: ready });
            },
            toggleOption: (configId) => {
                const settings = get().settings;
                if (settings.kind !== "ready") {
                    return;
                }
                const ready = {
                    ...settings,
                    changedOptionIds: new Set([...settings.changedOptionIds, configId]),
                    options: settings.options.map((option) =>
                        option.id === configId && option.type === "boolean"
                            ? { ...option, booleanValue: !option.booleanValue }
                            : option,
                    ),
                };
                rememberAgentSettings(ready);
                set({ settings: ready });
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
