import type { NativeSessionEntry, NativeSessionResult, SessionReadyEvent } from "@morty-build/client/channel";
import type { NativeSessionTarget } from "@morty-build/client/protocol";
import type { ChatAccess, ConversationActiveTurn } from "../../services/chat/bot-chat-api.ts";

export interface OpenMortySession {
    readonly harness: string;
    readonly result:
        | Extract<NativeSessionResult, { readonly ready: unknown }>
        | {
              readonly action: "conversation";
              readonly access: ChatAccess;
              readonly ready: SessionReadyEvent;
              readonly target: NativeSessionTarget;
              readonly activeTurn: ConversationActiveTurn;
          }
        | {
              readonly action: "managed";
              readonly target: NativeSessionTarget;
              readonly ready: SessionReadyEvent;
          };
    readonly entry: NativeSessionEntry;
}

/** The selected Session retains its connection metadata; its display title belongs to the title store. */
export type SelectedMortySession = Omit<OpenMortySession, "entry"> & {
    readonly entry: Omit<NativeSessionEntry, "title">;
};

export function selectedSession(session: OpenMortySession): SelectedMortySession {
    const { title: _title, ...entry } = session.entry;
    return { ...session, entry };
}
