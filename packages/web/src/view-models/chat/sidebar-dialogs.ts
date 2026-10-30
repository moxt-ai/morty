import { createStore, type StoreApi } from "zustand/vanilla";
import type { BotChatApi, ChatRuntime } from "../../services/chat/bot-chat-api.ts";
import type { IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import type { Clock } from "../../services/time/clock.ts";
import { createIdentitySharingStore, type IdentitySharingStore } from "./identity-sharing-store.ts";
import { createNativeSessionStore, type NativeSessionStore } from "./native-session-store.ts";
import type { OpenMobiusSession } from "./open-session.ts";

export type SidebarDialogs = StoreApi<SidebarDialogsState>;

interface SidebarDialogsState {
    readonly mobileNavOpen: boolean;
    readonly mobileSessionsOpen: boolean;
    /** Timestamp until which the mobile sessions sheet ignores outside-pointer dismissals. */
    readonly mobileSheetDismissLockedUntil: number;
    readonly nativeDialog: StoreApi<NativeSessionStore> | null;
    /** A closed dialog's store, kept so reopening the sheet returns to the session the user was reading. */
    readonly retainedNativeDialog: StoreApi<NativeSessionStore> | null;
    /** The phone sheet's drill-down step: the session list, or the previewed session's detail. */
    readonly nativeDialogStep: "list" | "detail";
    readonly sharing: StoreApi<IdentitySharingStore> | null;
    readonly openMobileNav: () => void;
    readonly closeMobileNav: () => void;
    /** Opens the mobile recent-sessions sheet and locks outside-pointer dismissal briefly so the same tap that opened it cannot close it. */
    readonly openMobileRecentSessions: () => void;
    readonly closeMobileRecentSessions: () => void;
    /** Closes the mobile recent-sessions sheet from an outside-pointer dismissal, ignored while the dismissal lock is held. */
    readonly dismissMobileRecentSessions: () => void;
    readonly openNativeDialog: () => void;
    readonly closeNativeDialog: () => void;
    /** Stops the dialog workflow for good: after a successful open, and when the sidebar detaches. */
    readonly discardNativeDialog: () => void;
    /** The phone sheet drills into the previewed session's detail. */
    readonly openNativeSessionDetail: () => void;
    /** The phone sheet returns from the detail to the session list. */
    readonly backToNativeSessionList: () => void;
    /** The Runtime configuration the page follows changed; an open Open Session dialog follows it. */
    readonly runtimeChanged: () => void;
    readonly openSharing: () => void;
    readonly closeSharing: () => void;
    /**
     * Announced with the sidebar's attached root element, following React's
     * ref-cleanup protocol: the view hands it straight to its root element's
     * ref and the returned function stops any dialog whose workflow is still
     * running. A WeakSet latches the node so a re-render of the same element
     * cannot re-run the cleanup.
     */
    readonly onAttach: (node: HTMLElement) => () => void;
}

/**
 * Owns the sidebar's ephemeral UI state and dialog workflows so the view
 * subscribes with `useStore` and wires only DOM callbacks. The native session
 * dialog's store is created when the dialog opens and kept when it closes, so
 * reopening the sheet returns to the session the user was reading; a successful
 * open and the sidebar detaching stop it for good, following the same
 * ref-cleanup protocol the chat root uses.
 */

const MOBILE_SHEET_DISMISS_LOCK_MILLISECONDS = 450;

export function createSidebarDialogs(options: {
    readonly clock: Clock;
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "nativeSessions" | "nativeSession" | "forkNativeSession">;
    /** The Runtime the page follows. */
    readonly runtime: () => ChatRuntime | null;
    readonly createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>;
    readonly onOpenSession: (session: OpenMobiusSession) => void;
    readonly onOpenedSession: () => void;
}): SidebarDialogs {
    const { botId, clock, requests, runtime, createTransfer, onOpenSession, onOpenedSession } = options;
    const attachedViews = new WeakSet<HTMLElement>();
    return createStore<SidebarDialogsState>()((set, get) => ({
        mobileNavOpen: false,
        mobileSessionsOpen: false,
        mobileSheetDismissLockedUntil: 0,
        nativeDialog: null,
        retainedNativeDialog: null,
        nativeDialogStep: "list",
        sharing: null,
        openMobileNav: () => set({ mobileNavOpen: true }),
        closeMobileNav: () => set({ mobileNavOpen: false }),
        openMobileRecentSessions: () =>
            set({
                mobileNavOpen: false,
                mobileSessionsOpen: true,
                mobileSheetDismissLockedUntil: clock.now() + MOBILE_SHEET_DISMISS_LOCK_MILLISECONDS,
            }),
        closeMobileRecentSessions: () => set({ mobileSessionsOpen: false }),
        dismissMobileRecentSessions: () => {
            if (clock.now() < get().mobileSheetDismissLockedUntil) {
                return;
            }
            set({ mobileSessionsOpen: false });
        },
        openNativeDialog: () => {
            if (get().nativeDialog !== null) {
                return;
            }
            const retained = get().retainedNativeDialog;
            if (retained !== null) {
                set({ nativeDialog: retained, retainedNativeDialog: null, nativeDialogStep: "list" });
                // Refresh the listing for the Runtime the page follows now; the
                // previewed entry stays selected when the refresh still lists it.
                retained.getState().start();
                return;
            }
            const store = createNativeSessionStore(botId, requests, runtime, (session) => {
                onOpenSession(session);
                get().discardNativeDialog();
                onOpenedSession();
            });
            store.getState().start();
            set({ nativeDialog: store, nativeDialogStep: "list" });
        },
        closeNativeDialog: () => {
            const dialog = get().nativeDialog;
            if (dialog === null) {
                return;
            }
            set({ nativeDialog: null, retainedNativeDialog: dialog });
        },
        discardNativeDialog: () => {
            const { nativeDialog, retainedNativeDialog } = get();
            nativeDialog?.getState().stop();
            retainedNativeDialog?.getState().stop();
            set({ nativeDialog: null, retainedNativeDialog: null, nativeDialogStep: "list" });
        },
        openNativeSessionDetail: () => set({ nativeDialogStep: "detail" }),
        backToNativeSessionList: () => set({ nativeDialogStep: "list" }),
        runtimeChanged: () => {
            get().nativeDialog?.getState().runtimeChanged();
        },
        openSharing: () => {
            if (get().sharing !== null) {
                return;
            }
            set({ sharing: createIdentitySharingStore(createTransfer) });
        },
        closeSharing: () => {
            const store = get().sharing;
            if (store === null) {
                return;
            }
            store.getState().dispose();
            set({ sharing: null });
        },
        onAttach: (node: HTMLElement) => {
            if (attachedViews.has(node)) {
                return () => {};
            }
            attachedViews.add(node);
            return () => {
                attachedViews.delete(node);
                get().discardNativeDialog();
                get().closeSharing();
            };
        },
    }));
}
