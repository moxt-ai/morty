import type { MobiusAgentActivityEvent } from "@moxt-ai/mobius-sdk";
import { activitiesForIds, type RecordedAgentActivity } from "../../services/chat/agent-activities.ts";
import type { SessionMessage } from "./session-presentation.ts";

type UserMessageBlock = Extract<SessionMessage, { readonly role: "user" }>;
type AssistantMessage = Extract<SessionMessage, { readonly role: "assistant" }>;

export type SessionDebugBlock =
    | UserMessageBlock
    | (AssistantMessage & { readonly activities: readonly MobiusAgentActivityEvent[] });

export function sessionDebugBlocks(state: {
    readonly activities: ReadonlyMap<string, RecordedAgentActivity>;
    readonly messages: readonly SessionMessage[];
}): readonly SessionDebugBlock[] {
    return Object.freeze(
        state.messages.map((message): SessionDebugBlock => {
            if (message.role === "user") {
                return Object.freeze(structuredClone(message));
            }
            return Object.freeze({
                ...structuredClone(message),
                activities: structuredClone(activitiesForIds(state.activities, message.activityIds)),
            });
        }),
    );
}
