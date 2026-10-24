import type { SessionConfigOption } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import { saveLastAgentSettings } from "../../services/chat/last-agent-settings.ts";
import { recordBrowserError } from "../../services/diagnostics/browser-diagnostics.ts";

// The Session's settings contract: the Runtime holds the Session's current
// settings, and the pane shows the latest report of them. Reports come from the
// Session as it opens, from each change it reports while the pane follows it (an
// event, or the reply to a change the user applied), and from a read whenever
// the history is loaded again, as on opening or reconnecting. Settings events in
// a loaded history only record past changes (a change from a settings menu writes
// none), so they never set the settings. The latest adopted report wins, and a
// slower read never replaces a newer one.

export interface SessionSettingsStore {
    readonly options: readonly SessionConfigOption[];
    /** Shows settings the Runtime reported and remembers them for the next draft. */
    readonly adopt: (options: readonly SessionConfigOption[]) => void;
    /**
     * Refines the shown settings from an authoritative read, made whenever the
     * history is loaded again. The conversation stays usable while the
     * read runs, a Runtime that cannot answer (such as a release from before
     * settings reads) keeps the current settings, and settings adopted after the
     * read started win. A newer read replaces an unfinished one.
     */
    readonly readInBackground: (
        read: (signal: AbortSignal) => Promise<{ readonly configOptions: readonly SessionConfigOption[] }>,
        parentSignal: AbortSignal,
    ) => void;
}

export function createSessionSettingsStore(options: {
    readonly botId: string;
    readonly agentRef: string;
    readonly initial: readonly SessionConfigOption[];
}) {
    return createStore<SessionSettingsStore>()((set, get) => {
        // Counts adopted settings so a slower read cannot replace settings observed after it started.
        let revision = 0;
        let pendingRead: AbortController | null = null;
        return {
            options: options.initial,
            adopt: (configOptions) => {
                revision += 1;
                saveLastAgentSettings(options.botId, options.agentRef, configOptions);
                set({ options: configOptions });
            },
            readInBackground: (read, parentSignal) => {
                pendingRead?.abort(new DOMException("A newer settings read replaced this one", "AbortError"));
                const controller = new AbortController();
                pendingRead = controller;
                const revisionAtStart = revision;
                const signal = AbortSignal.any([parentSignal, controller.signal, AbortSignal.timeout(45_000)]);
                void read(signal)
                    .then(
                        (result) => {
                            if (!parentSignal.aborted && !controller.signal.aborted && revision === revisionAtStart) {
                                get().adopt(result.configOptions);
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
