import { Brain, ChevronDown, LoaderCircle, Wrench } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ThinkingPresentation } from "../../services/chat/agent-reply.ts";
import { AgentMarkdown } from "../agents/agent-markdown.tsx";

export function AgentWorkingIndicator() {
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

export function AgentThinking({ autoOpen, entries }: ThinkingPresentation) {
    const disclosure = useRef<HTMLDetailsElement>(null);
    useEffect(() => {
        if (disclosure.current !== null) {
            disclosure.current.open = autoOpen;
        }
    }, [autoOpen]);
    if (entries.length === 0) {
        return null;
    }
    return (
        <div className="min-w-0 text-sm text-muted-foreground">
            <details aria-label="Agent thinking" className="group/thinking min-w-0" ref={disclosure}>
                <summary className="flex min-h-10 w-fit cursor-pointer list-none items-center gap-2 rounded-lg px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                    <ChevronDown
                        aria-hidden="true"
                        className="size-3.5 -rotate-90 transition-transform group-open/thinking:rotate-0 motion-reduce:transition-none"
                    />
                    <span>Show intermediate steps</span>
                </summary>
                <div className="mt-1 ml-1 min-w-0 border-l border-[#d9dde1] py-2 pl-5 [overflow-wrap:anywhere]">
                    <div className="grid min-w-0 gap-4 text-muted-foreground">
                        {entries.map((entry) => (
                            <section className="min-w-0" key={entry.id}>
                                {entry.kind === "reasoning" ? (
                                    <div className="grid min-w-0 gap-2">
                                        <div className="flex items-center gap-2 text-sm text-copy-secondary">
                                            <Brain aria-hidden="true" className="size-4" />
                                            <span>Thinking</span>
                                        </div>
                                        <AgentMarkdown markdown={entry.text} streaming={entry.status === "streaming"} />
                                    </div>
                                ) : (
                                    <details aria-label={`Tool: ${entry.title}`} className="group/tool min-w-0">
                                        <summary className="flex min-h-8 w-fit cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-sm text-copy-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                                            <ChevronDown
                                                aria-hidden="true"
                                                className="size-3.5 -rotate-90 transition-transform group-open/tool:rotate-0 motion-reduce:transition-none"
                                            />
                                            <Wrench aria-hidden="true" className="size-4" />
                                            <span>{entry.title}</span>
                                        </summary>
                                        <div className="mt-1 ml-5 grid min-w-0 gap-2 text-xs">
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
                                    </details>
                                )}
                            </section>
                        ))}
                    </div>
                </div>
            </details>
        </div>
    );
}
