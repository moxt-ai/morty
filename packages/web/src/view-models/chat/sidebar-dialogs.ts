import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import { createIdentitySharingStore } from "./identity-sharing-store.ts";
import { createNativeSessionStore } from "./native-session-store.ts";
import type { OpenMobiusSession } from "./open-session.ts";

/**
 * Owns the sidebar's dialog workflows so the view wires only DOM callbacks.
 * The native session dialog's store is created when the dialog opens and
 * stopped when it closes; the sidebar detaching with a dialog still open stops
 * it too, following the same ref-cleanup protocol the chat root uses.
 */
export function createSidebarDialogs(options: {
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "nativeSessions" | "nativeSession" | "runtimeConfiguration">;
    readonly createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>;
    readonly onOpenSession: (session: OpenMobiusSession) => void;
    readonly onOpenedSession: () => void;
}) {
    const { botId, requests, createTransfer, onOpenSession, onOpenedSession } = options;
    const attachedViews = new WeakSet<HTMLElement>();
    let nativeDialog: ReturnType<typeof createNativeSessionStore> | null = null;
    let sharing: ReturnType<typeof createIdentitySharingStore> | null = null;
    const listeners = new Set<() => void>();
    const announce = (): void => {
        for (const listener of listeners) {
            listener();
        }
    };
    const dialogs = {
        subscribe: (listener: () => void): (() => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        nativeDialog: (): ReturnType<typeof createNativeSessionStore> | null => nativeDialog,
        sharing: (): ReturnType<typeof createIdentitySharingStore> | null => sharing,
        openNativeDialog: (): void => {
            const store = createNativeSessionStore(botId, requests, (session) => {
                onOpenSession(session);
                dialogs.closeNativeDialog();
                onOpenedSession();
            });
            store.getState().start();
            nativeDialog = store;
            announce();
        },
        closeNativeDialog: (): void => {
            if (nativeDialog === null) {
                return;
            }
            nativeDialog.getState().stop();
            nativeDialog = null;
            announce();
        },
        openSharing: (): void => {
            sharing = createIdentitySharingStore(createTransfer);
            announce();
        },
        closeSharing: (): void => {
            if (sharing === null) {
                return;
            }
            sharing.getState().dispose();
            sharing = null;
            announce();
        },
        /**
         * Announced with the sidebar's attached root element, following
         * React's ref-cleanup protocol: the view hands it straight to its
         * root element's ref and the returned function stops any dialog whose
         * workflow is still running. A WeakSet latches the node so a
         * re-render of the same element cannot re-run the cleanup.
         */
        onAttach: (node: HTMLElement): (() => void) => {
            if (attachedViews.has(node)) {
                return () => {};
            }
            attachedViews.add(node);
            return () => {
                attachedViews.delete(node);
                dialogs.closeNativeDialog();
                dialogs.closeSharing();
            };
        },
    };
    return dialogs;
}
