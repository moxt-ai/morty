import type { NativeSessionEntry, NativeSessionResult, SessionReadyEvent } from "@moxt-ai/mobius-sdk/channel";
import type { ChatAccess, ConversationActiveTurn } from "../../services/chat/bot-chat-api.ts";

export interface OpenMobiusSession {
    readonly agentRef: string;
    readonly instructions?: string;
    readonly result:
        | Extract<NativeSessionResult, { readonly ready: unknown }>
        | {
              readonly action: "conversation";
              readonly access: ChatAccess;
              readonly ready: SessionReadyEvent;
              readonly targetSessionId: string;
              readonly activeTurn: ConversationActiveTurn;
          }
        | {
              readonly action: "managed";
              readonly targetSessionId: string;
              readonly ready: SessionReadyEvent;
          };
    readonly entry: NativeSessionEntry;
}
