import { createStore } from "zustand/vanilla";
import {
    accessEndingAcknowledgedEntry,
    centralLocalStorage,
} from "../../services/local-storage/central-local-storage.ts";
import type { Clock } from "../../services/time/clock.ts";

/** How long before this browser's access ends it is told once, so it can get a new link before work is cut off. */
const reminderLead = 60 * 60 * 1000;

/** When the reminder for access that ends at `expiresAt` is due. */
function accessReminderAt(expiresAt: string): number {
    return Date.parse(expiresAt) - reminderLead;
}

type AccessExpiryState =
    | { readonly kind: "unknown" }
    /** `expiresAt` is null for access that does not end on its own. */
    | { readonly kind: "known"; readonly expiresAt: string | null; readonly reminding: boolean };

export interface AccessExpiryStore {
    readonly state: AccessExpiryState;
    /** Reads when access ends while the page is visible, and reminds once when that is near. */
    readonly onAttach: (node: HTMLElement | null) => (() => void) | undefined;
    /** The user saw the reminder; it is not shown again for the same access. */
    readonly dismiss: () => void;
}

/**
 * When this browser's access ends. The Worker states the term, so this browser's clock only decides when to remind.
 * A hidden page waits; a page shown again reads the term anew, since another tab may have replaced the access and a
 * phone may have slept through the moment the reminder was due.
 */
export function createAccessExpiryStore(options: {
    readonly projectId: string;
    readonly accessExpiresAt: (signal: AbortSignal) => Promise<string | null>;
    readonly clock: Clock;
}) {
    const acknowledged = accessEndingAcknowledgedEntry(options.projectId);
    return createStore<AccessExpiryStore>()((set, get) => {
        const follow = async (signal: AbortSignal): Promise<void> => {
            let expiresAt: string | null;
            try {
                expiresAt = await options.accessExpiresAt(signal);
            } catch {
                // Access that ended is handled by the request that found it; the next visit reads again.
                return;
            }
            if (signal.aborted) {
                return;
            }
            const due = expiresAt === null || centralLocalStorage.read(acknowledged) === expiresAt ? null : expiresAt;
            set({ state: { kind: "known", expiresAt, reminding: false } });
            if (due === null) {
                return;
            }
            const wait = accessReminderAt(due) - options.clock.now();
            if (wait > 0) {
                try {
                    await options.clock.sleep(wait, signal);
                } catch {
                    return;
                }
            }
            set({ state: { kind: "known", expiresAt, reminding: true } });
        };
        return {
            state: { kind: "unknown" },
            onAttach: (node) => {
                if (node === null) {
                    return;
                }
                const lifetime = new AbortController();
                let visible: AbortController | null = null;
                const followWhileVisible = () => {
                    visible?.abort();
                    visible = null;
                    if (document.visibilityState === "visible") {
                        visible = new AbortController();
                        void follow(AbortSignal.any([lifetime.signal, visible.signal]));
                    }
                };
                document.addEventListener("visibilitychange", followWhileVisible, { signal: lifetime.signal });
                followWhileVisible();
                return () => lifetime.abort();
            },
            dismiss: () => {
                const state = get().state;
                if (state.kind === "known" && state.expiresAt !== null) {
                    centralLocalStorage.write(acknowledged, state.expiresAt);
                    set({ state: { ...state, reminding: false } });
                }
            },
        };
    });
}
