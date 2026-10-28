import { Check, ChevronRight, CircleAlert, CircleHelp, LoaderCircle } from "lucide-react";
import { Fragment, type ReactNode, useId, useState } from "react";
import { cn } from "../../lib/utils.ts";
import { agentThinkStepTriggerClassName } from "./tools/tool-call-status.tsx";
import { WorkingIndicator } from "./working-indicator.tsx";

export interface TurnWorkSummary {
    readonly backgroundRunning: number;
    readonly backgroundUnknown: number;
    readonly fileEdits: number;
    readonly failed: number;
    readonly interrupted: number;
    readonly steps: number;
    readonly phase: string;
    readonly tone: "working" | "waiting" | "attention" | "settled";
}

function counted(count: number, singular: string, plural: string): string {
    return `${count.toString()} ${count === 1 ? singular : plural}`;
}

/** One persistent disclosure per consecutive run of tool calls and reasoning. */
export function TurnWorkDisclosure({
    children,
    summary,
    startedAt,
}: {
    readonly children: (open: boolean) => ReactNode;
    readonly summary: TurnWorkSummary;
    readonly startedAt?: number | undefined;
}) {
    const [open, setOpen] = useState(false);
    const contentId = useId();
    const parts: { readonly key: string; readonly text: string; readonly alert: boolean }[] = [
        {
            key: "steps",
            text: summary.steps === 0 ? "Reasoning" : counted(summary.steps, "step", "steps"),
            alert: false,
        },
    ];
    if (summary.backgroundRunning > 0) {
        parts.push({
            key: "background-running",
            text: `${summary.backgroundRunning.toString()} running in background`,
            alert: false,
        });
    }
    if (summary.backgroundUnknown > 0) {
        parts.push({
            key: "background-unknown",
            text: `${summary.backgroundUnknown.toString()} status unknown`,
            alert: false,
        });
    }
    if (summary.fileEdits > 0) {
        parts.push({ key: "edits", text: counted(summary.fileEdits, "file edit", "file edits"), alert: false });
    }
    if (summary.failed > 0) {
        parts.push({ key: "failed", text: `${summary.failed.toString()} failed`, alert: true });
    }
    if (summary.interrupted > 0) {
        parts.push({ key: "interrupted", text: `${summary.interrupted.toString()} interrupted`, alert: true });
    }
    const Icon =
        summary.tone === "working"
            ? LoaderCircle
            : summary.tone === "waiting"
              ? CircleHelp
              : summary.tone === "attention"
                ? CircleAlert
                : Check;
    return (
        <fieldset aria-label="Execution details" className="m-0 min-w-0 border-0 p-0">
            <button
                aria-controls={contentId}
                aria-expanded={open}
                aria-describedby={`${contentId}-summary`}
                aria-label={open ? "Hide execution details" : "Show execution details"}
                className={cn(agentThinkStepTriggerClassName, "items-center flex-wrap gap-y-0")}
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
                <Icon
                    aria-hidden="true"
                    className={cn(
                        "size-3.5 shrink-0",
                        summary.tone === "working" && "animate-spin motion-reduce:animate-none",
                        summary.tone === "attention" && "text-destructive",
                    )}
                />
                <span
                    id={`${contentId}-summary`}
                    aria-live="polite"
                    aria-atomic="true"
                    className="min-w-0 text-left font-medium text-copy-secondary"
                >
                    {summary.phase}
                </span>
                <span aria-hidden="true" className="text-copy-tertiary">
                    ·
                </span>
                <span className="min-w-0 text-left text-copy-tertiary">
                    {parts.map((part, index) => (
                        <Fragment key={part.key}>
                            {index > 0 && " · "}
                            <span className={cn(part.alert && "text-destructive")}>{part.text}</span>
                        </Fragment>
                    ))}
                </span>
                {startedAt !== undefined && <WorkingIndicator compact startedAt={startedAt} />}
            </button>
            <div className={cn("min-w-0", open && "mt-2 border-l border-border pl-4")} id={contentId}>
                {children(open)}
            </div>
        </fieldset>
    );
}
