import type { NativeHistoryMessage } from "@moxt-ai/mobius-protocol";
import { type ReactNode, useRef } from "react";
import { flushSync } from "react-dom";
import { AgentMarkdown } from "../../components/agents/agent-markdown.tsx";
import type { LocalHistoryState } from "../../view-models/chat/local-history-store.ts";

export type TurnState =
    | { readonly kind: "idle" }
    | {
          readonly kind: "running";
          readonly commandId: string;
          readonly sessionId: string;
          readonly prompt: string;
          readonly text: string;
          readonly truncated: boolean;
      }
    | { readonly kind: "unknown"; readonly message: string; readonly prompt: string };

export function LocalAgentTranscript({
    messages,
    history,
    loadMore,
    turn,
    historyError,
    readImage,
    children,
}: {
    readonly messages: readonly NativeHistoryMessage[];
    readonly history: LocalHistoryState;
    readonly loadMore: () => void;
    readonly turn: TurnState;
    readonly historyError: string | null;
    readonly readImage: (
        path: string,
        signal: AbortSignal,
    ) => Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }>;
    readonly children: ReactNode;
}) {
    const transcript = useRef<HTMLDivElement>(null);
    const data =
        history.kind === "ready" || history.kind === "refreshing" || history.kind === "failed" ? history.data : null;
    const hiddenCount = data === null ? 0 : data.messages.length - data.visibleCount;
    const firstIndex = data === null ? 0 : hiddenCount;
    const revealOlder = () => {
        const viewport = transcript.current;
        if (viewport === null) {
            return;
        }
        const previousHeight = viewport.scrollHeight;
        const previousTop = viewport.scrollTop;
        flushSync(loadMore);
        viewport.scrollTop = previousTop + viewport.scrollHeight - previousHeight;
    };
    return (
        <div aria-label="Messages" className="flex-1 space-y-5 overflow-y-auto px-6 py-5" ref={transcript} role="log">
            {history.kind === "loading" && <p role="status">Loading conversation…</p>}
            {history.kind === "refreshing" && <p role="status">Refreshing conversation…</p>}
            {data?.truncated && <p>Older messages are unavailable because the local history was truncated.</p>}
            {hiddenCount > 0 && (
                <button onClick={revealOlder} type="button">
                    Load more
                </button>
            )}
            {messages.map((message, index) => (
                <article
                    aria-label={message.role === "user" ? "Message from you" : "Agent response"}
                    className="mx-auto max-w-3xl"
                    key={`${(firstIndex + index).toString()}:${message.role}`}
                >
                    <p className="mb-1 text-xs font-semibold text-muted-foreground">
                        {message.role === "user" ? "You" : "Agent"}
                    </p>
                    <AgentMarkdown markdown={message.text} readImage={readImage} streaming={false} />
                    {message.images?.map((image) => (
                        <img
                            alt={image.name}
                            className="mt-2 max-h-96 max-w-full rounded-lg"
                            key={`${image.name}:${image.mimeType}:${image.data.slice(0, 32)}`}
                            src={`data:${image.mimeType};base64,${image.data}`}
                        />
                    ))}
                </article>
            ))}
            {turn.kind === "running" && (
                <>
                    <article aria-label="Message from you" className="mx-auto max-w-3xl">
                        <p className="mb-1 text-xs font-semibold text-muted-foreground">You</p>
                        <AgentMarkdown markdown={turn.prompt} readImage={readImage} streaming={false} />
                    </article>
                    <article aria-label="Current Agent response" className="mx-auto max-w-3xl">
                        <p className="text-xs font-semibold text-muted-foreground">Agent is working</p>
                        {turn.truncated && <p>Earlier live output is unavailable in this view.</p>}
                        <AgentMarkdown markdown={turn.text} readImage={readImage} streaming />
                    </article>
                </>
            )}
            {turn.kind === "unknown" && (
                <div role="alert">
                    <p>{turn.message}</p>
                    <p className="mt-2 whitespace-pre-wrap">{turn.prompt}</p>
                </div>
            )}
            {historyError !== null && <p role="alert">{historyError}</p>}
            {children}
        </div>
    );
}
