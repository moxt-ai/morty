import { ChevronDown, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dataTestId } from "../../data-testid.ts";

export type CompactionStatusState = "in_progress" | "completed" | "failed" | "cancelled";

const STATUS_LABEL: Readonly<Record<CompactionStatusState, string>> = {
    cancelled: "cancelled",
    completed: "completed",
    failed: "failed",
    in_progress: "compacting",
};

/** Renders one ID-addressed context compaction: a status disclosure whose body is
 *  the retained summary the Agent streamed while compacting. */
export function CompactionDisclosure({
    error,
    status,
    summary,
}: {
    readonly error: string | null;
    readonly status: CompactionStatusState;
    readonly summary: string;
}) {
    const disclosure = useRef<HTMLDetailsElement>(null);
    const [contentVisible, setContentVisible] = useState(status === "in_progress");
    const [userToggled, setUserToggled] = useState(false);
    useEffect(() => {
        if (disclosure.current !== null && !userToggled) {
            disclosure.current.open = status === "in_progress";
            setContentVisible(status === "in_progress");
        }
    }, [status, userToggled]);
    const summaryVisible = contentVisible && summary.trim().length > 0;
    return (
        <details
            aria-label="Context compaction"
            className="group/compaction min-w-0"
            data-testid={dataTestId.agentCompaction}
            onToggle={(event) => {
                setUserToggled(true);
                setContentVisible(event.currentTarget.open);
            }}
            ref={disclosure}
        >
            <summary className="flex min-h-10 w-fit cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-muted-foreground outline-none hover:text-copy-secondary focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronDown
                    aria-hidden="true"
                    className="size-3.5 -rotate-90 transition-transform group-open/compaction:rotate-0 motion-reduce:transition-none"
                />
                <FileText aria-hidden="true" className="size-4" />
                <span>{`Context compaction ${STATUS_LABEL[status]}`}</span>
            </summary>
            {contentVisible && (
                <div className="mt-1 ml-1 grid min-w-0 gap-4 border-l border-[#d9dde1] py-2 pl-5 [overflow-wrap:anywhere]">
                    <section className="grid min-w-0 gap-2">
                        {error !== null && error.length > 0 && (
                            <p className="m-0 text-xs text-destructive" role="alert">
                                {error}
                            </p>
                        )}
                        {summaryVisible && (
                            <pre className="m-0 max-h-64 overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-6 text-muted-foreground">
                                {summary}
                            </pre>
                        )}
                    </section>
                </div>
            )}
        </details>
    );
}
