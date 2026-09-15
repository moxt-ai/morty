import type { MobiusAgentActivityEvent, MobiusAttemptSummary } from "@moxt-ai/mobius-sdk";
import type { ReactNode } from "react";
import { describeAgentReply, type ReplyPhase } from "../../services/chat/agent-reply.ts";
import { AgentMarkdown } from "../agents/agent-markdown.tsx";
import { AgentThinking } from "./agent-thinking.tsx";
import { AttemptFailure } from "./attempt-failure.tsx";
import { MessageBubble } from "./message-bubble.tsx";

function ReplyStatus({ phase, hasText }: { readonly phase: ReplyPhase; readonly hasText: boolean }) {
    let message: string;
    switch (phase) {
        case "working":
        case "failed":
            return null;
        case "completed":
            if (hasText) {
                return null;
            }
            message = "Agent finished without a text response.";
            break;
        case "waiting":
            message = "Your agent needs input. Check your local agent.";
            break;
        case "cancelled":
            message = "Response cancelled.";
            break;
        case "interrupted":
            message = "Agent updates stopped. Check your local agent or reconnect.";
            break;
    }
    return (
        <p role="status" className="px-4 text-sm text-muted-foreground">
            {message}
        </p>
    );
}

export function AgentReply({
    text,
    attempt,
    activities,
    active,
    botId,
    children,
    "data-testid": testId,
}: {
    readonly text: string;
    readonly attempt: MobiusAttemptSummary | null;
    readonly activities: readonly MobiusAgentActivityEvent[];
    readonly active: boolean;
    readonly botId: string;
    readonly children?: ReactNode;
    readonly "data-testid"?: string;
}) {
    const { phase, thinking } = describeAgentReply(attempt, activities, active);
    const hasText = text.length > 0;
    return (
        <div className="min-w-0 space-y-3">
            <AgentThinking {...thinking} />
            {hasText && (
                <MessageBubble speaker="assistant" data-testid={testId}>
                    <AgentMarkdown markdown={text} streaming={phase === "working"} />
                </MessageBubble>
            )}
            {children}
            <ReplyStatus phase={phase} hasText={hasText} />
            {attempt !== null && <AttemptFailure attempt={attempt} botId={botId} />}
        </div>
    );
}
