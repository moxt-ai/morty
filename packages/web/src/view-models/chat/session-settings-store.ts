import type { SessionConfigOption } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import { saveLastAgentSettings } from "../../services/chat/last-agent-settings.ts";
import { recordBrowserError } from "../../services/diagnostics/browser-diagnostics.ts";

// Runtime snapshots own current settings. Live updates and history reloads request a new
// snapshot; historical configuration events never become current settings. The revision
// travels with its snapshot and is sent only for explicit edits. Legacy Runtimes omit it.

type ConfigurationSnapshot = {
    readonly configOptions: readonly SessionConfigOption[];
    readonly configurationRevision?: string | undefined;
};

export interface SessionSettingsStore {
    readonly configurationRevision: string | undefined;
    readonly options: readonly SessionConfigOption[];
    /** Shows settings the Runtime reported and remembers them for the next draft. */
    readonly adopt: (snapshot: ConfigurationSnapshot) => void;
    /**
     * Refines the shown settings from an authoritative read, made whenever the
     * history is loaded again. The conversation stays usable while the
     * read runs, a Runtime that cannot answer (such as a release from before
     * settings reads) keeps the current settings, and settings adopted after the
     * read started win. A newer read replaces an unfinished one.
     */
    readonly readInBackground: (
        read: (signal: AbortSignal) => Promise<ConfigurationSnapshot>,
        parentSignal: AbortSignal,
    ) => void;
}

export function createSessionSettingsStore(options: {
    readonly botId: string;
    readonly agentRef: string;
    readonly initial: ConfigurationSnapshot;
}) {
    return createStore<SessionSettingsStore>()((set, get) => {
        let pendingRead: AbortController | null = null;
        return {
            options: options.initial.configOptions,
            configurationRevision: options.initial.configurationRevision,
            adopt: ({ configOptions, configurationRevision }) => {
                pendingRead?.abort(new DOMException("Newer settings were adopted", "AbortError"));
                pendingRead = null;
                saveLastAgentSettings(options.botId, options.agentRef, configOptions);
                set({ options: configOptions, configurationRevision });
            },
            readInBackground: (read, parentSignal) => {
                pendingRead?.abort(new DOMException("A newer settings read replaced this one", "AbortError"));
                const controller = new AbortController();
                pendingRead = controller;
                const signal = AbortSignal.any([parentSignal, controller.signal, AbortSignal.timeout(45_000)]);
                void read(signal)
                    .then(
                        (result) => {
                            if (!parentSignal.aborted && !controller.signal.aborted) {
                                get().adopt(result);
                            }
                        },
                        (cause: unknown) => {
                            if (!parentSignal.aborted && !controller.signal.aborted) {
                                recordBrowserError("read-session-settings", cause);
                            }
                        },
                    )
                    .finally(() => {
                        if (pendingRead === controller) {
                            pendingRead = null;
                        }
                    });
            },
        };
    });
}
