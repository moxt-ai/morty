import { Check, ChevronDown, CircleMinus, LoaderCircle, X } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { cn } from "../../../lib/utils.ts";
import type { ToolCallState } from "./tool-renderer.ts";

export const ToolCallSupplementalContent = createContext<ReactNode>(null);

/** Shared trigger row for intermediate agent steps (thinking rail + tool calls). */
export const agentThinkStepTriggerClassName =
    "flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-md px-0.5 py-1 text-[13px] leading-[22px] text-muted-foreground outline-none hover:text-copy-secondary focus-visible:ring-2 focus-visible:ring-ring/60";

const agentThinkStepTitleClassName = "min-w-0 truncate text-left";

export const agentThinkStepInlineLabelClassName = "flex min-w-0 flex-1 max-w-full items-start gap-2";

/** Chevron hidden until hover, focus, or open; does not occupy width while hidden. */
export const agentThinkStepChevronClassName =
    "mt-0.5 hidden size-3.5 shrink-0 -rotate-90 transition-transform motion-reduce:transition-none";

export const agentThinkStepExpandedPanelClassName =
    "mb-1 ml-2 grid min-w-0 gap-2 border-l border-[#d9dde1] py-2 pl-5 [overflow-wrap:anywhere]";

const toolCallStatusIconClassName = "block shrink-0";

const toolCallStatusRenderedStrokePx = 1.3;

/** Lucide strokes scale with icon size (viewBox 24). */
const toolCallStatusStrokeWidthAt12Px = (toolCallStatusRenderedStrokePx * 24) / 12;

const toolCallStatusSlotClassName = "inline-flex shrink-0 items-center justify-center leading-[22px]";

export function ToolCallDisclosure({
    ariaLabel,
    autoOpen,
    children,
    icon,
    state,
    testId,
    title,
}: {
    readonly ariaLabel: string;
    readonly autoOpen: boolean;
    readonly children?: ReactNode;
    readonly icon: ReactNode;
    readonly state: ToolCallState;
    readonly testId?: string | undefined;
    readonly title: string;
}) {
    const [open, setOpen] = useState(autoOpen);
    const supplementalContent = useContext(ToolCallSupplementalContent);
    useEffect(() => {
        if (autoOpen) {
            setOpen(true);
        }
    }, [autoOpen]);
    return (
        <fieldset aria-label={ariaLabel} className="group/tool m-0 min-w-0 border-0 p-0" data-testid={testId}>
            <button
                aria-expanded={open}
                className={cn(agentThinkStepTriggerClassName, "group/trigger items-center")}
                onClick={() => setOpen((current) => !current)}
                title={title}
                type="button"
            >
                <span className="shrink-0 [&>svg]:size-3.5">{icon}</span>
                <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden leading-[22px]">
                    <span className={cn(agentThinkStepTitleClassName, "leading-[22px]")}>{title}</span>
                    <span className={toolCallStatusSlotClassName}>
                        <ToolCallStatus state={state} />
                    </span>
                    <ChevronDown
                        aria-hidden="true"
                        className={cn(
                            agentThinkStepChevronClassName,
                            "mt-0 group-focus-visible/trigger:inline group-hover/trigger:inline",
                            open && "inline rotate-0",
                        )}
                    />
                </span>
            </button>
            {open && (
                <div className={agentThinkStepExpandedPanelClassName}>
                    {children}
                    {supplementalContent}
                </div>
            )}
        </fieldset>
    );
}

function ToolCallStatus({ state }: { readonly state: ToolCallState }) {
    switch (state.kind) {
        case "running":
            return (
                <LoaderCircle
                    aria-label="Tool running"
                    className={cn(
                        toolCallStatusIconClassName,
                        "size-3 animate-spin text-primary motion-reduce:animate-none",
                    )}
                    strokeWidth={toolCallStatusStrokeWidthAt12Px}
                />
            );
        case "succeeded":
            return (
                <Check
                    aria-label="Tool succeeded"
                    className={cn(toolCallStatusIconClassName, "size-3 text-emerald-600")}
                    strokeWidth={toolCallStatusStrokeWidthAt12Px}
                />
            );
        case "failed":
            return (
                <X
                    aria-label="Tool failed"
                    className={cn(toolCallStatusIconClassName, "size-3 text-destructive")}
                    strokeWidth={toolCallStatusStrokeWidthAt12Px}
                />
            );
        case "interrupted":
            return (
                <CircleMinus
                    aria-label="Tool interrupted"
                    className={cn(toolCallStatusIconClassName, "size-3 text-muted-foreground")}
                    strokeWidth={toolCallStatusStrokeWidthAt12Px}
                />
            );
        case "unknown":
            return null;
    }
}
