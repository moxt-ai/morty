import { Brain, ChevronDown, LoaderCircle } from "lucide-react";
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
        <div className="min-w-0 text-sm text-muted-foreground">
            <details aria-label="Agent thinking" className="group/thinking min-w-0">
                <summary className="flex min-h-10 w-fit cursor-pointer list-none items-center gap-2 rounded-lg px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                    <ChevronDown
                        aria-hidden="true"
                        className="size-3.5 -rotate-90 transition-transform group-open/thinking:rotate-0 motion-reduce:transition-none"
                    />
                    <span>{thinking ? "Show intermediate steps · Thinking…" : "Show intermediate steps"}</span>
                    {thinking && <WorkingIndicator />}
                </summary>
                <div className="mt-1 ml-1 min-w-0 border-l border-[#d9dde1] py-2 pl-5 [overflow-wrap:anywhere]">
                    <div className="mb-3 flex items-center gap-2 text-sm text-copy-secondary">
                        <Brain aria-hidden="true" className="size-4" />
                        <span>Thinking</span>
                    </div>
                    <div className="grid min-w-0 gap-3 text-muted-foreground">
                        {entries.map((entry) => (
                            <AgentMarkdown
                                key={entry.id}
                                markdown={entry.text}
                                streaming={entry.status === "streaming"}
                            />
                        ))}
                    </div>
                </div>
            </details>
            {status === "working" && <WorkingLabel status="working" />}
        </div>
    );
}
