import type { NativeSessionTarget } from "@morty-build/client/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
    agentQuestionChoicesEntry,
    centralSessionStorage,
    sessionDraftEntry,
} from "../../services/session-storage/central-session-storage.ts";
import type { AgentQuestionChoices } from "./agent-question-answer.ts";
import { type ComposerAttachmentStore, createComposerAttachmentStore } from "./composer-attachment-store.ts";
import { prependToDraft } from "./session-delivery-store.ts";

/**
 * What the user is writing to a Session on this page: the composer's text and files, the title being edited and the
 * answers picked for the Agent's questions. It belongs to the Session, not to the pane showing it, so replacing the
 * pane on a re-read or reconnection changes none of it.
 */
export interface SessionComposerStore {
    readonly draft: string;
    readonly attachments: StoreApi<ComposerAttachmentStore>;
    /** The draft holds a message returned for editing whose files could not be restored on this page. */
    readonly filesRestoreNotice: boolean;
    /** The title being edited; null while the editor is closed. */
    readonly titleDraft: string | null;
    /** The suggested answers picked for the questions Agent messages ask, by message. */
    readonly answerChoices: ReadonlyMap<string, AgentQuestionChoices>;
    readonly setDraft: (draft: string) => void;
    /** The composer's message left as a submission: its text, files and notice go with it. */
    readonly sent: () => void;
    /**
     * Returns a message the user takes back for editing to the composer, ahead of what was written since.
     * `filesLost` says whether files it had could not be restored here.
     */
    readonly returnMessage: (content: string, filesLost: boolean) => void;
    /** The draft page that followed its first message here hands over the text and files written meanwhile. */
    readonly adoptHandoff: (draft: string, attachments: StoreApi<ComposerAttachmentStore>) => void;
    readonly openTitleEdit: (title: string) => void;
    readonly setTitleDraft: (draft: string) => void;
    readonly closeTitleEdit: () => void;
    /** Picks `answer` for a question of an open question message; picks for messages no longer open are dropped. */
    readonly chooseAnswer: (
        openMessageIds: ReadonlySet<string>,
        messageId: string,
        questionIndex: number,
        answer: string,
    ) => void;
}

/**
 * The Session's composer, persisted for the next page where it is today: the draft and the picked answers. A message an
 * earlier page left unsent comes back ahead of the draft, never delivered implicitly.
 */
export function createSessionComposerStore(botId: string, sessionTarget: NativeSessionTarget, unsent: string | null) {
    const draftEntry = sessionDraftEntry(botId, sessionTarget);
    const answerChoicesEntry = agentQuestionChoicesEntry(botId, sessionTarget);
    const saveDraft = (draft: string): void => {
        if (draft === "") {
            centralSessionStorage.remove(draftEntry);
        } else {
            centralSessionStorage.write(draftEntry, draft);
        }
    };
    const stored = centralSessionStorage.read(draftEntry) ?? "";
    const initialDraft = unsent === null ? stored : prependToDraft(unsent, stored);
    saveDraft(initialDraft);
    return createStore<SessionComposerStore>()((set, get) => {
        const setDraft = (draft: string, filesRestoreNotice: boolean): void => {
            saveDraft(draft);
            set({ draft, filesRestoreNotice: draft !== "" && filesRestoreNotice });
        };
        return {
            draft: initialDraft,
            attachments: createComposerAttachmentStore(),
            filesRestoreNotice: false,
            titleDraft: null,
            answerChoices: new Map(Object.entries(centralSessionStorage.read(answerChoicesEntry) ?? {})),
            setDraft: (draft) => setDraft(draft, get().filesRestoreNotice),
            sent: () => {
                get().attachments.getState().clear();
                setDraft("", false);
            },
            returnMessage: (content, filesLost) => {
                const current = get().draft;
                setDraft(current.trim() === "" ? content : prependToDraft(content, current), filesLost);
            },
            adoptHandoff: (draft, attachments) => {
                saveDraft(draft);
                set({ draft, attachments, filesRestoreNotice: false });
            },
            openTitleEdit: (title) => set({ titleDraft: title }),
            setTitleDraft: (draft) => {
                if (get().titleDraft !== null) {
                    set({ titleDraft: draft });
                }
            },
            closeTitleEdit: () => set({ titleDraft: null }),
            chooseAnswer: (openMessageIds, messageId, questionIndex, answer) => {
                if (!openMessageIds.has(messageId)) {
                    return;
                }
                const choices = new Map([...get().answerChoices].filter(([id]) => openMessageIds.has(id)));
                choices.set(messageId, { ...choices.get(messageId), [questionIndex.toString()]: answer });
                centralSessionStorage.write(answerChoicesEntry, Object.fromEntries(choices));
                set({ answerChoices: choices });
            },
        };
    });
}
