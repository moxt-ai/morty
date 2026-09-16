import type { AgentDisplayContent, MobiusMessage } from "@moxt-ai/mobius-sdk";
import { useEffect, useState } from "react";
import { AgentRichContent } from "../../components/agents/agent-rich-content.tsx";
import { AgentReply } from "../../components/chat/agent-reply.tsx";
import { MessageBubble } from "../../components/chat/message-bubble.tsx";
import { dataTestId } from "../../data-testid.ts";
import { activitiesForTurn, type RecordedAgentActivity } from "../../services/chat/agent-activities.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";

function BotArtifactContent({
    botId,
    contents,
    requests,
    sessionId,
}: {
    readonly botId: string;
    readonly contents: readonly AgentDisplayContent[];
    readonly requests: Pick<BotChatApi, "connectSession">;
    readonly sessionId: string;
}) {
    const [connection, setConnection] = useState<
        | { readonly kind: "loading" }
        | { readonly kind: "ready"; readonly client: Awaited<ReturnType<BotChatApi["connectSession"]>> }
        | { readonly kind: "failed" }
    >({ kind: "loading" });
    useEffect(() => {
        const controller = new AbortController();
        let connected: Awaited<ReturnType<BotChatApi["connectSession"]>> | null = null;
        void requests
            .connectSession(botId, sessionId, controller.signal)
            .then((client) => {
                if (controller.signal.aborted) {
                    client.close();
                    return;
                }
                connected = client;
                setConnection({ kind: "ready", client });
            })
            .catch(() => {
                if (!controller.signal.aborted) {
                    setConnection({ kind: "failed" });
                }
            });
        return () => {
            controller.abort();
            connected?.close();
        };
    }, [botId, requests, sessionId]);
    switch (connection.kind) {
        case "loading":
            return <p className="text-xs text-muted-foreground">Loading image…</p>;
        case "failed":
            return <p className="text-xs text-muted-foreground">Image content could not be loaded.</p>;
        case "ready":
            return <AgentRichContent contents={contents} serviceClient={connection.client} sessionId={sessionId} />;
    }
}

export function BotConversationTurn({
    turn,
    activities,
    botId,
    requests,
}: {
    readonly turn: MobiusMessage;
    readonly activities: ReadonlyMap<string, RecordedAgentActivity>;
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "connectSession">;
}) {
    const turnActivities = activitiesForTurn(activities, turn.sessionId, turn.commandId);
    const images = turnActivities.flatMap((activity) => activity.content.filter((content) => content.type === "image"));
    return (
        <div className="mx-auto grid min-w-0 w-full max-w-[1120px] gap-8 [overflow-wrap:anywhere]">
            <MessageBubble speaker="user" data-testid={dataTestId.userMessage}>
                {turn.prompt}
            </MessageBubble>
            <AgentReply
                text={turn.response}
                attempt={turn.attempt}
                activities={turnActivities}
                active={true}
                botId={botId}
                data-testid={dataTestId.agentResponse}
            >
                {images.length > 0 && (
                    <section aria-label="Agent image output" className="min-w-0 px-4">
                        <BotArtifactContent
                            botId={botId}
                            contents={images}
                            requests={requests}
                            sessionId={turn.sessionId}
                        />
                    </section>
                )}
            </AgentReply>
        </div>
    );
}
