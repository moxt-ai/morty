import type { MobiusAgentActivityEvent, MobiusAttemptSummary } from "@moxt-ai/mobius-sdk";
import type { ReactNode } from "react";
import { dataTestId } from "../../data-testid.ts";
import { describeAgentReply, type ReplyPhase } from "../../services/chat/agent-reply.ts";
import type { MarkdownImageReader } from "../agents/agent-markdown.tsx";
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
        <p data-testid={dataTestId.agentReplyStatus} role="status" className="px-4 text-sm text-muted-foreground">
            {message}
        </p>
    );
}

export function AgentReply({
    text,
    attempt,
    activities,
    active,
    latest,
    botId,
    children,
    openLocalFile,
    readImage,
    "data-testid": testId,
}: {
    readonly text: string;
    readonly attempt: MobiusAttemptSummary | null;
    readonly activities: readonly MobiusAgentActivityEvent[];
    readonly active: boolean;
    readonly latest: boolean;
    readonly botId: string;
    readonly children?: ReactNode;
    readonly openLocalFile?: ((path: string) => void) | undefined;
    readonly readImage?: MarkdownImageReader | undefined;
    readonly "data-testid"?: string;
}) {
    const hasText = text.length > 0;
    const { phase, thinking } = describeAgentReply(attempt, activities, active, latest && !hasText);
    return (
        <div className="min-w-0 space-y-3" data-testid={testId}>
            <AgentThinking {...thinking} />
            {hasText && (
                <MessageBubble speaker="assistant">
                    <AgentMarkdown
                        markdown={text}
                        openLocalFile={openLocalFile}
                        readImage={readImage}
                        streaming={phase === "working" && latest}
                    />
                </MessageBubble>
            )}
            {children}
            <ReplyStatus phase={phase} hasText={hasText} />
            {attempt !== null && <AttemptFailure attempt={attempt} botId={botId} />}
        </div>
    );
}
