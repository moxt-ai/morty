import { Brain, ChevronDown, Wrench } from "lucide-react";
import { useEffect, useRef } from "react";
import { dataTestId } from "../../data-testid.ts";
import type { SessionToolPresentation } from "../../view-models/chat/session-presentation.ts";
import { AgentMarkdown, type MarkdownImageReader } from "../agents/agent-markdown.tsx";
import { AgentRichContent } from "../agents/agent-rich-content.tsx";
import { FollowLatestScrollArea } from "../utils/follow-latest-scroll-area.tsx";
import { ToolCallDisclosure, ToolCallSupplementalContent } from "./tools/tool-call-status.tsx";
import { toolRichContent } from "./tools/tool-display-content.ts";
import { renderRegisteredTool } from "./tools/tool-renderer-registry.tsx";

export type AgentThinkingEntry =
    | {
          readonly id: string;
          readonly kind: "reasoning";
          readonly messageId: string | null;
          readonly text: string;
      }
    | SessionToolPresentation;

type ReasoningEntry = Extract<AgentThinkingEntry, { readonly kind: "reasoning" }>;
type TimelineEntry =
    | { readonly entry: ReasoningEntry; readonly kind: "reasoning" }
    | { readonly entry: SessionToolPresentation; readonly kind: "tool" };

function ReasoningContent({ active, entry }: { readonly active: boolean; readonly entry: ReasoningEntry }) {
    const content = useRef<HTMLDivElement>(null);
    return (
        <FollowLatestScrollArea
            className="overscroll-contain [scrollbar-color:#c8d5ce_transparent] [scrollbar-width:thin]"
            container={content}
            followThreshold={24}
            style={{ maxHeight: "10.5rem", overflowY: "auto" }}
        >
            <AgentMarkdown markdown={entry.text} streaming={active} />
        </FollowLatestScrollArea>
    );
}

function ReasoningDisclosure({ active, entry }: { readonly active: boolean; readonly entry: ReasoningEntry }) {
    const disclosure = useRef<HTMLDetailsElement>(null);
    useEffect(() => {
        if (disclosure.current !== null) {
            disclosure.current.open = active;
        }
    }, [active]);
    return (
        <details
            aria-label="Agent thinking"
            className="group/thinking min-w-0"
            data-testid={dataTestId.agentReasoning}
            ref={disclosure}
        >
            <summary className="flex min-h-10 w-fit cursor-pointer list-none items-center gap-2 rounded-lg px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronDown
                    aria-hidden="true"
                    className="size-3.5 -rotate-90 transition-transform group-open/thinking:rotate-0 motion-reduce:transition-none"
                />
                <span>Show intermediate steps</span>
            </summary>
            <div className="mt-1 ml-1 grid min-w-0 gap-4 border-l border-[#d9dde1] py-2 pl-5 [overflow-wrap:anywhere]">
                <section className="grid min-w-0 gap-2">
                    <div className="flex items-center gap-2 text-sm text-copy-secondary">
                        <Brain aria-hidden="true" className="size-4" />
                        <span>Thinking</span>
                    </div>
                    <ReasoningContent active={active} entry={entry} />
                </section>
            </div>
        </details>
    );
}

function ToolCall({
    entry,
    readImage,
}: {
    readonly entry: SessionToolPresentation;
    readonly readImage?: MarkdownImageReader | undefined;
}) {
    const registered = renderRegisteredTool(entry);
    const supplementalContent = <AgentRichContent contents={toolRichContent(entry.content)} readImage={readImage} />;
    if (registered !== null) {
        return <ToolCallSupplementalContent value={supplementalContent}>{registered}</ToolCallSupplementalContent>;
    }
    return (
        <ToolCallSupplementalContent value={supplementalContent}>
            <ToolCallDisclosure
                ariaLabel={`Tool: ${entry.title}`}
                autoOpen={false}
                icon={<Wrench aria-hidden="true" className="size-4 shrink-0" />}
                state={entry.state}
                testId={dataTestId.agentToolCall}
                title={entry.title}
            >
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
            </ToolCallDisclosure>
        </ToolCallSupplementalContent>
    );
}

export function AgentThinking({
    active,
    entries,
    readImage,
}: {
    readonly active: boolean;
    readonly entries: readonly AgentThinkingEntry[];
    readonly readImage?: MarkdownImageReader | undefined;
}) {
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
        let messageId = first.messageId;
        let text = first.text;
        for (const entry of reasoning.slice(1)) {
            text += entry.messageId === messageId ? entry.text : `\n\n${entry.text}`;
            messageId = entry.messageId;
        }
        timeline.push({ entry: { ...first, text }, kind: "reasoning" });
        reasoning = [];
    };
    for (const entry of entries) {
        if (entry.kind === "reasoning") {
            reasoning.push(entry);
        } else {
            flushReasoning();
            timeline.push({ entry, kind: "tool" });
        }
    }
    flushReasoning();
    const currentEntry = timeline.at(-1);
    return (
        <div className="grid min-w-0 gap-3 text-sm text-muted-foreground">
            {timeline.map((item) =>
                item.kind === "reasoning" ? (
                    <ReasoningDisclosure
                        active={active && item === currentEntry}
                        entry={item.entry}
                        key={`reasoning:${item.entry.id}`}
                    />
                ) : (
                    <ToolCall entry={item.entry} key={`tool:${item.entry.id}`} readImage={readImage} />
                ),
            )}
        </div>
    );
}
