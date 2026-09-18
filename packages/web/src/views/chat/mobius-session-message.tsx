import type { MobiusClient } from "@moxt-ai/mobius-sdk";
import { CircleAlert } from "lucide-react";
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
    deliveryUnknownUserMessageId,
    onRetryUnknownDelivery,
    sessionId,
    botId,
    client,
}: {
    readonly message: SessionMessage;
    readonly activities: ReadonlyMap<string, RecordedAgentActivity>;
    readonly activeCommandId: string | null;
    readonly activeMessageId: string | null;
    readonly activeUserMessageId: string | null;
    readonly deliveryUnknownUserMessageId: string | null;
    readonly onRetryUnknownDelivery: () => void;
    readonly sessionId: string;
    readonly botId: string;
    readonly client: Pick<MobiusClient, "artifacts" | "sessions"> | null;
}) {
    if (message.role === "user") {
        const deliveryUnknown = message.id === deliveryUnknownUserMessageId;
        return (
            <div className="min-w-0 space-y-2">
                {message.text.length > 0 && (
                    <MessageBubble
                        copyText={message.text}
                        speaker="user"
                        status={
                            deliveryUnknown ? (
                                <button
                                    aria-label="Retry message with unknown delivery"
                                    className="inline-flex size-7 items-center justify-center rounded-full text-destructive outline-none hover:bg-destructive/8 focus-visible:ring-2 focus-visible:ring-destructive/40"
                                    onClick={onRetryUnknownDelivery}
                                    title="Delivery unknown — retry message"
                                    type="button"
                                >
                                    <CircleAlert aria-hidden="true" className="size-4.5" />
                                </button>
                            ) : message.id === activeUserMessageId ? (
                                <AgentWorkingIndicator />
                            ) : undefined
                        }
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
                {deliveryUnknown && (
                    <p
                        className="ml-auto max-w-[82%] rounded-lg border border-destructive/15 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive"
                        role="alert"
                    >
                        Delivery wasn’t confirmed. This message won’t be sent again unless you retry it.
                    </p>
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
