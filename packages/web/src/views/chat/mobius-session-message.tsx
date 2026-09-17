import type { MobiusAttemptSummary } from "@moxt-ai/mobius-sdk";
import { AgentReply } from "../../components/chat/agent-reply.tsx";
import { MessageBubble } from "../../components/chat/message-bubble.tsx";
import { dataTestId } from "../../data-testid.ts";
import { activitiesForTurn, type RecordedAgentActivity } from "../../services/chat/agent-activities.ts";

export type SessionMessage =
    | { readonly role: "user"; readonly id: string; readonly text: string }
    | {
          readonly role: "assistant";
          readonly id: string;
          readonly text: string;
          readonly commandId: string | null;
          readonly attempt: MobiusAttemptSummary | null;
      };

export function MobiusSessionMessage({
    message,
    activities,
    activeCommandId,
    sessionId,
    botId,
}: {
    readonly message: SessionMessage;
    readonly activities: ReadonlyMap<string, RecordedAgentActivity>;
    readonly activeCommandId: string | null;
    readonly sessionId: string;
    readonly botId: string;
}) {
    if (message.role === "user") {
        return (
            <MessageBubble speaker="user" data-testid={dataTestId.userMessage}>
                {message.text}
            </MessageBubble>
        );
    }
    const turnActivities =
        message.commandId === null ? [] : activitiesForTurn(activities, sessionId, message.commandId);
    return (
        <AgentReply
            text={message.text}
            attempt={message.attempt}
            activities={turnActivities}
            active={activeCommandId !== null && message.commandId === activeCommandId}
            botId={botId}
            data-testid={dataTestId.agentResponse}
        />
    );
}
