import type { AgentDisplayContent, MobiusAttemptSummary, MobiusClient } from "@moxt-ai/mobius-sdk";
import { AgentRichContent } from "../../components/agents/agent-rich-content.tsx";
import { AgentReply } from "../../components/chat/agent-reply.tsx";
import { MessageBubble } from "../../components/chat/message-bubble.tsx";
import { activitiesForTurn, type RecordedAgentActivity } from "../../services/chat/agent-activities.ts";

export type LocalMessage =
    | {
          readonly role: "user";
          readonly id: string;
          readonly text: string;
          readonly contents: readonly LocalMessageContent[];
      }
    | {
          readonly role: "assistant";
          readonly id: string;
          readonly text: string;
          readonly commandId: string | null;
          readonly attempt: MobiusAttemptSummary | null;
          readonly contents: readonly LocalMessageContent[];
      };

export interface LocalMessageContent {
    readonly contentId: string;
    readonly content: AgentDisplayContent;
}

export function LocalSessionMessage({
    message,
    activities,
    activeCommandId,
    sessionId,
    botId,
    client,
}: {
    readonly message: LocalMessage;
    readonly activities: ReadonlyMap<string, RecordedAgentActivity>;
    readonly activeCommandId: string | null;
    readonly sessionId: string;
    readonly botId: string;
    readonly client: Pick<MobiusClient, "artifacts"> | null;
}) {
    if (message.role === "user") {
        return (
            <div className="min-w-0 space-y-2">
                {message.text.length > 0 && <MessageBubble speaker="user">{message.text}</MessageBubble>}
                <AgentRichContent
                    contents={message.contents.map((entry) => entry.content)}
                    serviceClient={client ?? undefined}
                    sessionId={sessionId}
                />
            </div>
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
        >
            <AgentRichContent
                contents={message.contents.map((entry) => entry.content)}
                serviceClient={client ?? undefined}
                sessionId={sessionId}
            />
        </AgentReply>
    );
}
