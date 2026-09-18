import type { AgentDisplayContent, MobiusAttemptSummary, MobiusClient } from "@moxt-ai/mobius-sdk";
import { AgentMarkdown } from "../../components/agents/agent-markdown.tsx";
import { AgentRichContent } from "../../components/agents/agent-rich-content.tsx";
import { AgentReply } from "../../components/chat/agent-reply.tsx";
import { AgentWorkingIndicator } from "../../components/chat/agent-thinking.tsx";
import { MessageBubble } from "../../components/chat/message-bubble.tsx";
import { dataTestId } from "../../data-testid.ts";
import { activitiesForIds, type RecordedAgentActivity } from "../../services/chat/agent-activities.ts";

export type SessionMessage =
    | {
          readonly role: "user";
          readonly id: string;
          readonly text: string;
          readonly contents: readonly SessionMessageContent[];
      }
    | {
          readonly role: "assistant";
          readonly activityIds: readonly string[];
          readonly id: string;
          readonly text: string;
          readonly commandId: string | null;
          readonly attempt: MobiusAttemptSummary | null;
          readonly contents: readonly SessionMessageContent[];
      };

export interface SessionMessageContent {
    readonly contentId: string;
    readonly content: AgentDisplayContent;
}

export function MobiusSessionMessage({
    message,
    activities,
    activeCommandId,
    activeMessageId,
    activeUserMessageId,
    sessionId,
    botId,
    client,
}: {
    readonly message: SessionMessage;
    readonly activities: ReadonlyMap<string, RecordedAgentActivity>;
    readonly activeCommandId: string | null;
    readonly activeMessageId: string | null;
    readonly activeUserMessageId: string | null;
    readonly sessionId: string;
    readonly botId: string;
    readonly client: Pick<MobiusClient, "artifacts"> | null;
}) {
    if (message.role === "user") {
        return (
            <div className="min-w-0 space-y-2">
                {message.text.length > 0 && (
                    <MessageBubble copyText={message.text} speaker="user" data-testid={dataTestId.userMessage}>
                        <AgentMarkdown className="[&_p]:my-0" markdown={message.text} streaming={false} />
                    </MessageBubble>
                )}
                <AgentRichContent
                    contents={message.contents.map((entry) => entry.content)}
                    serviceClient={client ?? undefined}
                    sessionId={sessionId}
                />
                {message.id === activeUserMessageId && (
                    <div className="flex min-h-6 items-end justify-end pt-1">
                        <AgentWorkingIndicator />
                    </div>
                )}
            </div>
        );
    }
    const turnActivities = activitiesForIds(activities, message.activityIds);
    return (
        <AgentReply
            text={message.text}
            attempt={message.attempt}
            activities={turnActivities}
            active={activeCommandId !== null && message.commandId === activeCommandId}
            latest={activeMessageId === message.id}
            botId={botId}
            data-testid={dataTestId.agentResponse}
        >
            <AgentRichContent
                contents={message.contents.map((entry) => entry.content)}
                serviceClient={client ?? undefined}
                sessionId={sessionId}
            />
        </AgentReply>
    );
}
