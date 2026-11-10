import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk/unstable";

type MessageUpdate = Extract<
    SessionUpdate,
    {
        readonly sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
    }
>;
type IdentifiedSessionUpdate = (MessageUpdate & { readonly messageId: string }) | Exclude<SessionUpdate, MessageUpdate>;
export interface IdentifiedSessionNotification extends Omit<SessionNotification, "update"> {
    readonly update: IdentifiedSessionUpdate;
}
