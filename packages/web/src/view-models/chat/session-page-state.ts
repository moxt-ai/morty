import type { StoreApi } from "zustand/vanilla";
import {
    centralSessionStorage,
    SessionStorageWriteError,
    sessionPendingSubmissionEntry,
    sessionUnsentMessageEntry,
} from "../../services/session-storage/central-session-storage.ts";
import { createSessionComposerStore, type SessionComposerStore } from "./session-composer-store.ts";
import { createSessionDeliveryStore, type SessionDeliveryStore } from "./session-delivery-store.ts";
import { createSessionMessageQueueStore, type SessionMessageQueueStore } from "./session-message-queue-store.ts";
import { createSessionRenameStore, type SessionRenameStore } from "./session-rename-store.ts";

/**
 * What the page holds for one Session, whichever pane shows it: what the user is writing, the messages
 * the page submitted, its requests on the Runtime's queue and a confirmed rename. A pane is replaced on every re-read
 * or reconnection; this state lasts as long as the page, so no replacement resets a Session fact.
 */
export interface SessionPageState {
    readonly composer: StoreApi<SessionComposerStore>;
    readonly delivery: StoreApi<SessionDeliveryStore>;
    readonly queue: StoreApi<SessionMessageQueueStore>;
    readonly rename: StoreApi<SessionRenameStore>;
}

/** Opens what the page holds for the Session, recovering what an earlier page persisted for it. */
export function createSessionPageState(options: {
    readonly botId: string;
    readonly sessionId: string;
    /** The page's lifetime, on which delivery runs each attempt. */
    readonly lifetime: AbortSignal;
}): SessionPageState {
    const { botId, sessionId } = options;
    const unsentEntry = sessionUnsentMessageEntry(sessionId);
    const pendingEntry = sessionPendingSubmissionEntry(botId, sessionId);
    // A message an earlier page left unsent returns to the composer; it is never delivered implicitly.
    const unsent = centralSessionStorage.read(unsentEntry);
    centralSessionStorage.remove(unsentEntry);
    return {
        composer: createSessionComposerStore(sessionId, unsent),
        delivery: createSessionDeliveryStore({
            lifetime: options.lifetime,
            pendingSubmission: centralSessionStorage.read(pendingEntry),
            pendingSubmissionChanged: (journal) => {
                if (journal === null) {
                    centralSessionStorage.remove(pendingEntry);
                } else if (!centralSessionStorage.write(pendingEntry, journal)) {
                    throw new SessionStorageWriteError();
                }
            },
            unsentMessageChanged: (content) => {
                if (content === null) {
                    centralSessionStorage.remove(unsentEntry);
                } else {
                    centralSessionStorage.write(unsentEntry, content);
                }
            },
        }),
        queue: createSessionMessageQueueStore(),
        rename: createSessionRenameStore(),
    };
}
