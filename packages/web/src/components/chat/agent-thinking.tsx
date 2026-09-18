import { Brain, ChevronDown, LoaderCircle, Wrench } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ThinkingEntry, ThinkingPresentation, ToolThinkingEntry } from "../../services/chat/agent-reply.ts";
import { AgentMarkdown } from "../agents/agent-markdown.tsx";
import { ToolCallStatus } from "./tool-call-status.tsx";
import { renderRegisteredTool } from "./tool-renderer-registry.tsx";

type ReasoningEntry = Extract<ThinkingEntry, { readonly kind: "reasoning" }>;
type ToolEntry = ToolThinkingEntry;
type TimelineEntry =
    | { readonly kind: "reasoning"; readonly id: string; readonly entries: readonly ReasoningEntry[] }
    | { readonly kind: "tool"; readonly entry: ToolEntry };

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

function ReasoningDisclosure({
    autoOpen,
    entries,
}: {
    readonly autoOpen: boolean;
    readonly entries: readonly ReasoningEntry[];
}) {
    const disclosure = useRef<HTMLDetailsElement>(null);
    useEffect(() => {
        if (disclosure.current !== null) {
            disclosure.current.open = autoOpen;
        }
    }, [autoOpen]);
    return (
        <details aria-label="Agent thinking" className="group/thinking min-w-0" ref={disclosure}>
            <summary className="flex min-h-10 w-fit cursor-pointer list-none items-center gap-2 rounded-lg px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronDown
                    aria-hidden="true"
                    className="size-3.5 -rotate-90 transition-transform group-open/thinking:rotate-0 motion-reduce:transition-none"
                />
                <span>Show intermediate steps</span>
            </summary>
            <div className="mt-1 ml-1 grid min-w-0 gap-4 border-l border-[#d9dde1] py-2 pl-5 [overflow-wrap:anywhere]">
                {entries.map((entry) => (
                    <section className="grid min-w-0 gap-2" key={entry.id}>
                        <div className="flex items-center gap-2 text-sm text-copy-secondary">
                            <Brain aria-hidden="true" className="size-4" />
                            <span>Thinking</span>
                        </div>
                        <AgentMarkdown markdown={entry.text} streaming={entry.status === "streaming"} />
                    </section>
                ))}
            </div>
        </details>
    );
}

function ToolCall({ autoOpen, entry }: { readonly autoOpen: boolean; readonly entry: ToolEntry }) {
    const registered = renderRegisteredTool(entry, autoOpen);
    if (registered !== null) {
        return registered;
    }
    return (
        <details aria-label={`Tool: ${entry.title}`} className="group/tool min-w-0">
            <summary
                className="flex min-h-8 w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-sm text-copy-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                title={entry.title}
            >
                <ChevronDown
                    aria-hidden="true"
                    className="size-4 shrink-0 -rotate-90 transition-transform group-open/tool:rotate-0 motion-reduce:transition-none"
                />
                <Wrench aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">{entry.title}</span>
                <ToolCallStatus state={entry.state} />
            </summary>
            <div className="mt-1 ml-5 grid min-w-0 gap-2 text-xs">
                {entry.input.length > 0 && (
                    <div className="grid gap-1">
                        <span className="font-medium text-copy-tertiary">Request</span>
                        <pre className="max-h-96 overflow-auto rounded-lg bg-black/[0.035] p-2 whitespace-pre-wrap">
                            {entry.input}
                        </pre>
                    </div>
                )}
                {entry.output.length > 0 && (
                    <div className="grid gap-1">
                        <span className="font-medium text-copy-tertiary">Response</span>
                        <pre className="max-h-96 overflow-auto rounded-lg bg-black/[0.035] p-2 whitespace-pre-wrap">
                            {entry.output}
                        </pre>
                    </div>
                )}
            </div>
        </details>
    );
}

export function AgentThinking({ autoOpen, entries }: ThinkingPresentation) {
    if (entries.length === 0) {
        return null;
    }
    const timeline: TimelineEntry[] = [];
    let reasoning: ReasoningEntry[] = [];
    const flushReasoning = (): void => {
        const first = reasoning[0];
        if (first === undefined) {
            return;
        }
        timeline.push({ kind: "reasoning", id: first.id, entries: reasoning });
        reasoning = [];
    };
    for (const entry of entries) {
        if (entry.kind === "reasoning") {
            reasoning.push(entry);
        } else {
            flushReasoning();
            timeline.push({ kind: "tool", entry });
        }
    }
    flushReasoning();
    const currentEntry = timeline.at(-1);
    const activeReasoningId = autoOpen && currentEntry?.kind === "reasoning" ? currentEntry.id : undefined;
    const activeToolId = autoOpen && currentEntry?.kind === "tool" ? currentEntry.entry.id : undefined;
    return (
        <div className="grid min-w-0 gap-3 text-sm text-muted-foreground">
            {timeline.map((item) =>
                item.kind === "reasoning" ? (
                    <ReasoningDisclosure
                        autoOpen={item.id === activeReasoningId}
                        entries={item.entries}
                        key={`reasoning:${item.id}`}
                    />
                ) : (
                    <ToolCall
                        autoOpen={item.entry.id === activeToolId}
                        entry={item.entry}
                        key={`tool:${item.entry.id}`}
                    />
                ),
            )}
        </div>
    );
}
