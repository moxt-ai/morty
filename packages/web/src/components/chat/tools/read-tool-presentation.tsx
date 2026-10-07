import type { AgentDisplayContent } from "@moxt-ai/mobius-sdk";
import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { dataTestId } from "../../../data-testid.ts";
import { AgentRichContent } from "../../agents/agent-rich-content.tsx";
import { ToolCallStatus, useToolCallDisclosure } from "./tool-call-status.tsx";
import { toolRichContent } from "./tool-display-content.ts";
import type { ToolCallState } from "./tool-renderer.ts";

export interface NumberedCodeLine {
    readonly code: string;
    readonly lineNumber: number;
}

export function NumberedCodeLines({ lines }: { readonly lines: readonly NumberedCodeLine[] }) {
    return (
        <div className="max-h-96 overflow-auto rounded-lg bg-black/[0.035] p-2 font-mono text-xs leading-5">
            {lines.map((line) => (
                <div className="grid min-w-max grid-cols-[max-content_minmax(0,1fr)] gap-3" key={line.lineNumber}>
                    <span className="select-none text-right text-copy-tertiary">{line.lineNumber}</span>
                    <code className="whitespace-pre">{line.code}</code>
                </div>
            ))}
        </div>
    );
}

export function ReadToolLabel({ children }: { readonly children: string }) {
    return (
        <span className="inline-flex w-fit rounded-md bg-black/[0.035] px-2 py-1 font-medium text-copy-secondary">
            {children}
        </span>
    );
}

export function ReadToolPresentation({
    autoOpen,
    children,
    content,
    path,
    state,
    title,
}: {
    readonly autoOpen: boolean;
    readonly children: ReactNode;
    readonly content: readonly AgentDisplayContent[];
    readonly path: string;
    readonly state: ToolCallState;
    readonly title: string;
}) {
    const disclosure = useToolCallDisclosure(autoOpen);
    return (
        <details
            aria-label={`Read: ${title}`}
            className="group/tool min-w-0"
            data-testid={dataTestId.recognizedReadToolCall}
            ref={disclosure}
        >
            <summary
                className="flex min-h-8 w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-sm text-copy-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                title={title}
            >
                <FileText aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">{title}</span>
                <ToolCallStatus state={state} />
            </summary>
            <div className="mt-1 ml-5 grid min-w-0 gap-2 text-xs">
                <div className="truncate font-mono text-copy-secondary" title={path}>
                    {path}
                </div>
                {children}
                <AgentRichContent contents={toolRichContent(content)} />
            </div>
        </details>
    );
}
