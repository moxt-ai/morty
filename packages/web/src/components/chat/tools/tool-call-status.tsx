import { ChevronDown, CircleCheck, CircleMinus, CircleX, LoaderCircle } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { ToolCallState } from "./tool-renderer.ts";

export const ToolCallSupplementalContent = createContext<ReactNode>(null);

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
                className="flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-1 text-sm text-copy-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setOpen((current) => !current)}
                title={title}
                type="button"
            >
                <ChevronDown
                    aria-hidden="true"
                    className={`size-4 shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-0" : "-rotate-90"}`}
                />
                {icon}
                <span className="min-w-0 flex-1 truncate text-left whitespace-nowrap">{title}</span>
                <ToolCallStatus state={state} />
            </button>
            {open && (
                <div className="grid min-w-0 gap-2">
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
                    className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
                />
            );
        case "succeeded":
            return <CircleCheck aria-label="Tool succeeded" className="size-4 shrink-0 text-emerald-600" />;
        case "failed":
            return <CircleX aria-label="Tool failed" className="size-4 shrink-0 text-destructive" />;
        case "interrupted":
            return <CircleMinus aria-label="Tool interrupted" className="size-4 shrink-0 text-muted-foreground" />;
        case "unknown":
            return null;
    }
}
