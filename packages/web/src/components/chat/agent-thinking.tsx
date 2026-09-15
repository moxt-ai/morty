import { Brain, ChevronRight, LoaderCircle } from "lucide-react";
import type { ThinkingPresentation } from "../../services/chat/agent-reply.ts";
import { AgentMarkdown } from "../agents/agent-markdown.tsx";

function WorkingIndicator() {
    return (
        <span role="status" aria-label="Agent working" className="inline-flex items-center gap-2">
            <LoaderCircle
                aria-hidden="true"
                className="size-3.5 animate-spin text-primary motion-reduce:animate-none"
            />
            <span className="sr-only">Agent is working</span>
        </span>
    );
}

function WorkingLabel({ status }: { readonly status: "working" | "thinking" }) {
    return (
        <div className="flex min-h-8 items-center gap-2 px-2 text-xs text-muted-foreground">
            <WorkingIndicator />
            <span>{status === "thinking" ? "Thinking…" : "Working…"}</span>
        </div>
    );
}

export function AgentThinking({ entries, status }: ThinkingPresentation) {
    if (entries.length === 0) {
        return status === "idle" ? null : <WorkingLabel status={status} />;
    }
    const thinking = status === "thinking";
    return (
        <div className="min-w-0 px-4 text-xs text-muted-foreground">
            <details aria-label="Agent thinking" className="group/thinking min-w-0">
                <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-2 rounded-md px-2 outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8">
                    <ChevronRight
                        aria-hidden="true"
                        className="size-3.5 transition-transform group-open/thinking:rotate-90 motion-reduce:transition-none"
                    />
                    <Brain aria-hidden="true" className="size-3.5" />
                    <span>{thinking ? "Thinking…" : "Thinking"}</span>
                    {thinking && <WorkingIndicator />}
                </summary>
                <div className="mt-2 ml-3 grid min-w-0 gap-3 border-l border-primary/20 pl-4 [overflow-wrap:anywhere]">
                    {entries.map((entry) => (
                        <AgentMarkdown key={entry.id} markdown={entry.text} streaming={entry.status === "streaming"} />
                    ))}
                </div>
            </details>
            {status === "working" && <WorkingLabel status="working" />}
        </div>
    );
}
