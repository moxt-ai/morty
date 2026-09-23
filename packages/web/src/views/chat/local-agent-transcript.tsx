import type { NativeHistoryMessage } from "@moxt-ai/mobius-protocol";
import type { ReactNode } from "react";
import { AgentMarkdown } from "../../components/agents/agent-markdown.tsx";

export type TurnState =
    | { readonly kind: "idle" }
    | {
          readonly kind: "running";
          readonly commandId: string;
          readonly sessionId: string;
          readonly prompt: string;
          readonly text: string;
      }
    | { readonly kind: "unknown"; readonly message: string; readonly prompt: string };

export function LocalAgentTranscript({
    messages,
    turn,
    historyError,
    readImage,
    children,
}: {
    readonly messages: readonly NativeHistoryMessage[];
    readonly turn: TurnState;
    readonly historyError: string | null;
    readonly readImage: (
        path: string,
        signal: AbortSignal,
    ) => Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }>;
    readonly children: ReactNode;
}) {
    return (
        <div aria-label="Messages" className="flex-1 space-y-5 overflow-y-auto px-6 py-5" role="log">
            {messages.map((message, index) => (
                <article
                    aria-label={message.role === "user" ? "Message from you" : "Agent response"}
                    className="mx-auto max-w-3xl"
                    key={`${index.toString()}:${message.role}`}
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
