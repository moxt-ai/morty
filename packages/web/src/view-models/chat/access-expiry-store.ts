import { createStore } from "zustand/vanilla";
import {
    type AccessAcknowledgement,
    accessAcknowledgedEntry,
    centralLocalStorage,
} from "../../services/local-storage/central-local-storage.ts";
import type { Clock } from "../../services/time/clock.ts";

/** How long before this browser's access ends it is told once, so it can get a new link before work is cut off. */
const reminderLead = 60 * 60 * 1000;

/** When the reminder for access that ends at `expiresAt` is due. */
function accessReminderAt(expiresAt: string): number {
    return Date.parse(expiresAt) - reminderLead;
}

/**
 * What this browser is told about its access, one thing at a time: that it joined and until when, once for each
 * access, and that the access ends soon, which supersedes it.
 */
type AccessNotice = "none" | "joined" | "ending";

/** What to tell this browser at `now` about access that ends at `expiresAt`, given what it was already told. */
function accessNotice(expiresAt: string, now: number, acknowledged: AccessAcknowledgement | null): AccessNotice {
    const through = acknowledged?.expiresAt === expiresAt ? acknowledged.through : null;
    if (through === "ending") {
        return "none";
    }
    if (now >= accessReminderAt(expiresAt)) {
        return "ending";
    }
    return through === "joined" ? "none" : "joined";
}

type AccessExpiryState =
    /** The term has not been read yet. */
    | { readonly kind: "unknown" }
    /** The term could not be read. The next visible visit tries again. */
    | { readonly kind: "unavailable" }
    /** `expiresAt` is null for access that does not end on its own, which has no notice. */
    | { readonly kind: "known"; readonly expiresAt: string | null; readonly notice: AccessNotice };

/** The card this browser should show, or null when access has nothing new to say. */
export function visibleAccessNotice(
    state: AccessExpiryState,
): { readonly expiresAt: string; readonly notice: "joined" | "ending" } | null {
    if (state.kind !== "known" || state.expiresAt === null || state.notice === "none") {
        return null;
    }
    return { expiresAt: state.expiresAt, notice: state.notice };
}

export interface AccessExpiryStore {
    readonly state: AccessExpiryState;
    /** Reads when access ends while the page is visible, and tells this browser about it at most once each way. */
    readonly onAttach: (node: HTMLElement | null) => (() => void) | undefined;
    /** The user saw the notice shown; it is not shown again for the same access. */
    readonly dismiss: () => void;
}

/**
 * When this browser's access ends. The Worker states the term, so this browser's clock only decides when to remind.
 * A hidden page waits; a page shown again reads the term anew, since another tab may have replaced the access and a
 * phone may have slept through the moment the reminder was due.
 */
export function createAccessExpiryStore(options: {
    readonly accountId: string;
    readonly accessExpiresAt: (signal: AbortSignal) => Promise<string | null>;
    readonly clock: Clock;
}) {
    const acknowledged = accessAcknowledgedEntry(options.accountId);
    return createStore<AccessExpiryStore>()((set, get) => {
        const tell = (expiresAt: string) =>
            set({
                state: {
                    kind: "known",
                    expiresAt,
                    notice: accessNotice(expiresAt, options.clock.now(), centralLocalStorage.read(acknowledged)),
                },
            });
        const follow = async (signal: AbortSignal): Promise<void> => {
            if (get().state.kind === "unavailable") {
                if (signal.aborted) {
                    return;
                }
                set({ state: { kind: "unknown" } });
            }
            let expiresAt: string | null;
            try {
                expiresAt = await options.accessExpiresAt(signal);
            } catch {
                // Access that ended is handled by the request that found it; the next visit reads again.
                // A term already on screen stays. Only a first read that failed leaves the card empty.
                if (!signal.aborted && get().state.kind === "unknown") {
                    set({ state: { kind: "unavailable" } });
                }
                return;
            }
            if (signal.aborted) {
                return;
            }
            if (expiresAt === null) {
                set({ state: { kind: "known", expiresAt, notice: "none" } });
                return;
            }
            tell(expiresAt);
            const remindAt = accessReminderAt(expiresAt);
            if (options.clock.now() >= remindAt) {
                return;
            }
            try {
                await options.clock.sleep(remindAt - options.clock.now(), signal);
            } catch {
                return;
            }
            tell(expiresAt);
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
                if (state.kind !== "known" || state.expiresAt === null || state.notice === "none") {
                    return;
                }
                centralLocalStorage.write(acknowledged, { expiresAt: state.expiresAt, through: state.notice });
                set({ state: { ...state, notice: "none" } });
            },
        };
    });
}
