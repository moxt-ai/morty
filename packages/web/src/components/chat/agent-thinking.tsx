import { Brain, ChevronDown, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dataTestId } from "../../data-testid.ts";
import {
    REASONING_CHARACTER_LIMIT,
    type SessionToolPresentation,
} from "../../view-models/chat/session-presentation.ts";
import type { MarkdownImageReader } from "../agents/agent-markdown.tsx";
import { AgentRichContent } from "../agents/agent-rich-content.tsx";
import { FollowLatestScrollArea } from "../utils/follow-latest-scroll-area.tsx";
import { ToolCallDisclosure, ToolCallSupplementalContent } from "./tools/tool-call-status.tsx";
import { toolRichContent } from "./tools/tool-display-content.ts";
import { renderRegisteredTool } from "./tools/tool-renderer-registry.tsx";
import { ToolTextPreview } from "./tools/tool-text-preview.tsx";

export type AgentThinkingEntry =
    | {
          readonly id: string;
          readonly kind: "reasoning";
          readonly messageId: string | null;
          readonly omitted: boolean;
          readonly text: string;
          readonly truncated: boolean;
      }
    | SessionToolPresentation;

type ReasoningEntry = Extract<AgentThinkingEntry, { readonly kind: "reasoning" }>;
type TimelineEntry =
    | { readonly entry: ReasoningEntry; readonly kind: "reasoning" }
    | { readonly entry: SessionToolPresentation; readonly kind: "tool" };

function ReasoningContent({ entry }: { readonly entry: ReasoningEntry }) {
    const content = useRef<HTMLDivElement>(null);
    return (
        <FollowLatestScrollArea
            className="overscroll-contain [scrollbar-color:#c8d5ce_transparent] [scrollbar-width:thin]"
            container={content}
            followThreshold={24}
            style={{ maxHeight: "10.5rem", overflowY: "auto" }}
        >
            <pre className="m-0 whitespace-pre-wrap font-sans text-[15px] leading-6 text-muted-foreground">
                {entry.text}
            </pre>
        </FollowLatestScrollArea>
    );
}

function ReasoningDisclosure({ active, entry }: { readonly active: boolean; readonly entry: ReasoningEntry }) {
    const disclosure = useRef<HTMLDetailsElement>(null);
    const [contentVisible, setContentVisible] = useState(active);
    useEffect(() => {
        if (disclosure.current !== null) {
            disclosure.current.open = active;
            setContentVisible(active);
        }
    }, [active]);
    return (
        <details
            aria-label="Agent thinking"
            className="group/thinking min-w-0"
            data-testid={dataTestId.agentReasoning}
            onToggle={(event) => setContentVisible(event.currentTarget.open)}
            ref={disclosure}
        >
            <summary className="flex min-h-10 w-fit cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-muted-foreground outline-none hover:text-copy-secondary focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronDown
                    aria-hidden="true"
                    className="size-3.5 -rotate-90 transition-transform group-open/thinking:rotate-0 motion-reduce:transition-none"
                />
                <span>Show Thinking</span>
            </summary>
            {contentVisible && (
                <div className="mt-1 ml-1 grid min-w-0 gap-4 border-l border-[#d9dde1] py-2 pl-5 [overflow-wrap:anywhere]">
                    <section className="grid min-w-0 gap-2">
                        <div className="flex items-center gap-2 text-sm text-copy-secondary">
                            <Brain aria-hidden="true" className="size-4" />
                            <span>Thinking</span>
                        </div>
                        {entry.truncated && (
                            <p className="m-0 text-xs text-copy-secondary">
                                Earlier reasoning was truncated to the most recent 16K characters.
                            </p>
                        )}
                        {entry.omitted && (
                            <p className="m-0 text-xs text-copy-secondary">(Reasoning details were omitted.)</p>
                        )}
                        <ReasoningContent entry={entry} />
                    </section>
                </div>
            )}
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
                            <ToolTextPreview text={entry.input} />
                        </div>
                    )}
                    {entry.output.length > 0 && (
                        <div className="grid gap-1">
                            <span className="font-medium text-copy-tertiary">Response</span>
                            <ToolTextPreview text={entry.output} />
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
        const text = [first.text];
        for (const entry of reasoning.slice(1)) {
            if (entry.messageId !== messageId) {
                text.push("\n\n");
            }
            text.push(entry.text);
            messageId = entry.messageId;
        }
        const combined = text.join("");
        timeline.push({
            entry: {
                ...first,
                omitted: reasoning.some((entry) => entry.omitted),
                text: combined.slice(-REASONING_CHARACTER_LIMIT),
                truncated: reasoning.some((entry) => entry.truncated) || combined.length > REASONING_CHARACTER_LIMIT,
            },
            kind: "reasoning",
        });
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
