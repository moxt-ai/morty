import type { MobiusClient } from "@moxt-ai/mobius-sdk";
import { AgentMarkdown } from "../../components/agents/agent-markdown.tsx";
import { AgentRichContent } from "../../components/agents/agent-rich-content.tsx";
import { AgentReply } from "../../components/chat/agent-reply.tsx";
import { AgentWorkingIndicator } from "../../components/chat/agent-thinking.tsx";
import { MessageBubble } from "../../components/chat/message-bubble.tsx";
import { dataTestId } from "../../data-testid.ts";
import { activitiesForIds, type RecordedAgentActivity } from "../../services/chat/agent-activities.ts";
import type { SessionMessage } from "../../view-models/chat/session-presentation.ts";

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
    readonly client: Pick<MobiusClient, "artifacts" | "sessions"> | null;
}) {
    if (message.role === "user") {
        return (
            <div className="min-w-0 space-y-2">
                {message.text.length > 0 && (
                    <MessageBubble
                        copyText={message.text}
                        speaker="user"
                        status={message.id === activeUserMessageId ? <AgentWorkingIndicator /> : undefined}
                        data-testid={dataTestId.userMessage}
                    >
                        <AgentMarkdown className="[&_p]:my-0" markdown={message.text} streaming={false} />
                    </MessageBubble>
                )}
                <AgentRichContent
                    contents={message.contents.map((entry) => entry.content)}
                    serviceClient={client ?? undefined}
                    sessionId={sessionId}
                />
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
