import { ChevronDown, FileText } from "lucide-react";
import { useState } from "react";
import { dataTestId } from "../../data-testid.ts";

export type CompactionStatusState = "in_progress" | "completed" | "failed" | "cancelled";

const STATUS_LABEL: Readonly<Record<CompactionStatusState, string>> = {
    cancelled: "cancelled",
    completed: "completed",
    failed: "failed",
    in_progress: "compacting",
};

/** The user's disclosure choice. "unset" follows the status default: an
 *  in-progress compaction expands so the streaming summary is visible, a
 *  terminal one collapses. An explicit choice overrides both defaults. */
type DisclosureChoice = "collapsed" | "expanded" | "unset";

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
    const [choice, setChoice] = useState<DisclosureChoice>("unset");
    const open = choice === "expanded" || (choice === "unset" && status === "in_progress");
    return (
        <fieldset
            aria-label="Context compaction"
            className="group/compaction m-0 min-w-0 border-0 p-0"
            data-testid={dataTestId.agentCompaction}
        >
            <button
                aria-expanded={open}
                className="flex min-h-10 w-fit cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-muted-foreground outline-none hover:text-copy-secondary focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setChoice(open ? "collapsed" : "expanded")}
                type="button"
            >
                <ChevronDown
                    aria-hidden="true"
                    className={`size-3.5 shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-0" : "-rotate-90"}`}
                />
                <FileText aria-hidden="true" className="size-4" />
                <span>{`Context compaction ${STATUS_LABEL[status]}`}</span>
            </button>
            {open && (
                <div className="mt-1 ml-1 grid min-w-0 gap-4 border-l border-[#d9dde1] py-2 pl-5 [overflow-wrap:anywhere]">
                    <section className="grid min-w-0 gap-2">
                        {error !== null && error.length > 0 && (
                            <p className="m-0 text-xs text-destructive" role="alert">
                                {error}
                            </p>
                        )}
                        {summary.trim().length > 0 && (
                            <pre className="m-0 max-h-64 overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-6 text-muted-foreground">
                                {summary}
                            </pre>
                        )}
                    </section>
                </div>
            )}
        </fieldset>
    );
}
