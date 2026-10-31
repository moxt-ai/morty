import type { SessionConfigOption } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import { recordBrowserError } from "../../services/diagnostics/browser-diagnostics.ts";

// Runtime snapshots own current settings. Live updates and history reloads request a new
// snapshot; historical configuration events never become current settings. The revision
// travels with its snapshot and is sent only for explicit edits.

type ConfigurationSnapshot = {
    readonly configOptions: readonly SessionConfigOption[];
    readonly configurationRevision: string;
};

export interface SessionSettingsStore {
    readonly openedAt: string;
    readonly observedAt: string;
    readonly source: "session-ready" | "session-configuration";
    readonly configurationRevision: string;
    readonly options: readonly SessionConfigOption[];
    /** Shows settings the Runtime reported. */
    readonly adopt: (snapshot: ConfigurationSnapshot) => void;
    /**
     * Refines the shown settings from an authoritative read, made whenever the
     * history is loaded again. The conversation stays usable while the
     * read runs, a Runtime that cannot answer keeps the current settings, and settings adopted after the
     * read started win. A newer read replaces an unfinished one.
     */
    readonly readInBackground: (
        read: (signal: AbortSignal) => Promise<ConfigurationSnapshot>,
        parentSignal: AbortSignal,
    ) => void;
}

export function createSessionSettingsStore(options: { readonly initial: ConfigurationSnapshot }) {
    return createStore<SessionSettingsStore>()((set, get) => {
        let pendingRead: AbortController | null = null;
        const openedAt = new Date().toISOString();
        return {
            openedAt,
            observedAt: openedAt,
            source: "session-ready",
            options: options.initial.configOptions,
            configurationRevision: options.initial.configurationRevision,
            adopt: ({ configOptions, configurationRevision }) => {
                pendingRead?.abort(new DOMException("Newer settings were adopted", "AbortError"));
                pendingRead = null;
                set({
                    options: configOptions,
                    configurationRevision,
                    observedAt: new Date().toISOString(),
                    source: "session-configuration",
                });
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
