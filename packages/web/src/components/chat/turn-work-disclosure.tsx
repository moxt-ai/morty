import { ChevronRight } from "lucide-react";
import { Fragment, type ReactNode, useId, useState } from "react";
import { cn } from "../../lib/utils.ts";
import { agentThinkStepTriggerClassName } from "./tools/tool-call-status.tsx";

export interface TurnWorkSummary {
    readonly fileEdits: number;
    readonly failed: number;
    readonly interrupted: number;
    readonly steps: number;
}

function counted(count: number, singular: string, plural: string): string {
    return `${count.toString()} ${count === 1 ? singular : plural}`;
}

/**
 * Collapses a completed turn's intermediate work (tool calls, reasoning, and
 * progress notes) behind one summary row so the final answer leads.
 */
export function TurnWorkDisclosure({
    children,
    summary,
}: {
    readonly children: ReactNode;
    readonly summary: TurnWorkSummary;
}) {
    const [open, setOpen] = useState(false);
    const contentId = useId();
    const parts: { readonly key: string; readonly text: string; readonly alert: boolean }[] = [
        { key: "steps", text: counted(summary.steps, "step", "steps"), alert: false },
    ];
    if (summary.fileEdits > 0) {
        parts.push({ key: "edits", text: counted(summary.fileEdits, "file edit", "file edits"), alert: false });
    }
    if (summary.failed > 0) {
        parts.push({ key: "failed", text: `${summary.failed.toString()} failed`, alert: true });
    }
    if (summary.interrupted > 0) {
        parts.push({ key: "interrupted", text: `${summary.interrupted.toString()} interrupted`, alert: true });
    }
    return (
        <div className="min-w-0 space-y-4">
            <button
                aria-controls={contentId}
                aria-expanded={open}
                className={cn(agentThinkStepTriggerClassName, "w-auto items-center")}
                onClick={() => setOpen((current) => !current)}
                type="button"
            >
                <ChevronRight
                    aria-hidden="true"
                    className={cn(
                        "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
                        open && "rotate-90",
                    )}
                />
                <span className="min-w-0 text-left">
                    {parts.map((part, index) => (
                        <Fragment key={part.key}>
                            {index > 0 && " · "}
                            <span className={cn(part.alert && "text-destructive")}>{part.text}</span>
                        </Fragment>
                    ))}
                </span>
            </button>
            {open && (
                <div className="min-w-0 space-y-4" id={contentId}>
                    {children}
                </div>
            )}
        </div>
    );
}
