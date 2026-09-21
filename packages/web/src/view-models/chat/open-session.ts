import type {
    NativeSessionEntry,
    NativeSessionHistory,
    NativeSessionResult,
    SessionReadyEvent,
} from "@moxt-ai/mobius-sdk/channel";
import type { ConversationActiveTurn } from "../../services/chat/bot-chat-api.ts";

export interface OpenMobiusSession {
    readonly agentRef: string;
    readonly result:
        | Extract<NativeSessionResult, { readonly ready: unknown }>
        | {
              readonly action: "conversation";
              readonly ready: SessionReadyEvent;
              readonly targetSessionId: string;
              readonly history: Extract<NativeSessionHistory, { readonly status: "unavailable" }>;
              readonly activeTurn: ConversationActiveTurn;
          };
    readonly entry: NativeSessionEntry;
}
