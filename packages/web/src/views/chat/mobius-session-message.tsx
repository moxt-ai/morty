import { CircleAlert, X } from "lucide-react";
import { AgentMarkdown, type MarkdownImageReader } from "../../components/agents/agent-markdown.tsx";
import { AgentRichContent } from "../../components/agents/agent-rich-content.tsx";
import { AgentReply } from "../../components/chat/agent-reply.tsx";
import { MessageBubble } from "../../components/chat/message-bubble.tsx";
import { dataTestId } from "../../data-testid.ts";
import { activitiesForIds, type RecordedAgentActivity } from "../../services/chat/agent-activities.ts";
import type { SessionMessage } from "../../view-models/chat/session-presentation.ts";

export function MobiusSessionMessage({
    message,
    activities,
    activeCommandId,
    activeMessageId,
    deliveryUnknownUserMessageId,
    onRemoveUnknownDelivery,
    onRetryUnknownDelivery,
    sessionId,
    botId,
    readImage,
    openLocalFile,
}: {
    readonly message: SessionMessage;
    readonly activities: ReadonlyMap<string, RecordedAgentActivity>;
    readonly activeCommandId: string | null;
    readonly activeMessageId: string | null;
    readonly deliveryUnknownUserMessageId: string | null;
    readonly onRemoveUnknownDelivery: () => void;
    readonly onRetryUnknownDelivery: () => void;
    readonly sessionId: string;
    readonly botId: string;
    readonly readImage: MarkdownImageReader;
    readonly openLocalFile: (path: string) => void;
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
                            ) : undefined
                        }
                        data-testid={dataTestId.userMessage}
                    >
                        <AgentMarkdown
                            className="[&_p]:my-0"
                            markdown={message.text}
                            openLocalFile={openLocalFile}
                            readImage={readImage}
                            streaming={false}
                        />
                    </MessageBubble>
                )}
                <div className="ml-auto max-w-[82%]">
                    <AgentRichContent
                        contents={message.contents.map((entry) => entry.content)}
                        mediaTestId={dataTestId.userMessageImage}
                        readImage={readImage}
                        openLocalFile={openLocalFile}
                        sessionId={sessionId}
                    />
                </div>
                {deliveryUnknown && (
                    <div
                        className="ml-auto flex max-w-[82%] items-center gap-3 rounded-lg border border-destructive/15 bg-destructive/5 py-2 pr-2 pl-3 text-xs leading-5 text-destructive"
                        role="alert"
                    >
                        <span className="min-w-0 flex-1">
                            Delivery wasn’t confirmed. This message won’t be sent again unless you retry it.
                        </span>
                        <button
                            aria-label="Remove failed message"
                            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-destructive/40"
                            onClick={onRemoveUnknownDelivery}
                            title="Remove failed message"
                            type="button"
                        >
                            <X aria-hidden="true" className="size-4" />
                        </button>
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
            openLocalFile={openLocalFile}
            readImage={readImage}
        >
            <AgentRichContent
                contents={message.contents.map((entry) => entry.content)}
                readImage={readImage}
                openLocalFile={openLocalFile}
                sessionId={sessionId}
            />
        </AgentReply>
    );
}
