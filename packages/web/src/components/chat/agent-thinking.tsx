import { Brain, ChevronDown, LoaderCircle, Wrench } from "lucide-react";
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
        <div className="flex min-h-6 items-end justify-end gap-2 pt-1 text-xs text-muted-foreground">
            <WorkingIndicator />
            {status === "thinking" && <span>Thinking…</span>}
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
                    <div className="grid min-w-0 gap-4 text-muted-foreground">
                        {entries.map((entry) => (
                            <section className="grid min-w-0 gap-2" key={entry.id}>
                                <div className="flex items-center gap-2 text-sm text-copy-secondary">
                                    {entry.kind === "reasoning" ? (
                                        <Brain aria-hidden="true" className="size-4" />
                                    ) : (
                                        <Wrench aria-hidden="true" className="size-4" />
                                    )}
                                    <span>{entry.kind === "reasoning" ? "Thinking" : entry.title}</span>
                                </div>
                                {entry.kind === "reasoning" ? (
                                    <AgentMarkdown markdown={entry.text} streaming={entry.status === "streaming"} />
                                ) : (
                                    <div className="grid min-w-0 gap-2 text-xs">
                                        {entry.input.length > 0 && (
                                            <div className="grid gap-1">
                                                <span className="font-medium text-copy-tertiary">Request</span>
                                                <pre className="overflow-x-auto rounded-lg bg-black/[0.035] p-2 whitespace-pre-wrap">
                                                    {entry.input}
                                                </pre>
                                            </div>
                                        )}
                                        {entry.output.length > 0 && (
                                            <div className="grid gap-1">
                                                <span className="font-medium text-copy-tertiary">Response</span>
                                                <pre className="overflow-x-auto rounded-lg bg-black/[0.035] p-2 whitespace-pre-wrap">
                                                    {entry.output}
                                                </pre>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </section>
                        ))}
                    </div>
                </div>
            </details>
            {status === "working" && <WorkingLabel status="working" />}
        </div>
    );
}
