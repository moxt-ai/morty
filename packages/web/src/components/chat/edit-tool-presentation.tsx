import { FileDiff } from "lucide-react";
import type { ReactNode } from "react";
import { HighlightedCode, languageForPath } from "./highlighted-code.tsx";
import { ToolCallStatus, useToolCallDisclosure } from "./tool-call-status.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

export interface FileDiffValue {
    readonly newText: string | null;
    readonly oldText: string | null;
    readonly path: string;
}

export function FileDiffList({ diffs }: { readonly diffs: readonly FileDiffValue[] }) {
    return diffs.map((diff) => (
        <section className="min-w-0 overflow-hidden rounded-lg border border-black/7" key={diff.path}>
            <div className="truncate border-b border-black/7 bg-black/[0.025] px-2.5 py-1.5 font-mono text-copy-secondary">
                {diff.path}
            </div>
            <div className="grid max-h-96 overflow-auto font-mono text-[11px] leading-[18px] md:grid-cols-2">
                <div className="min-w-0 bg-[#fff4f2] text-[#8f2f35]">
                    <HighlightedCode code={diff.oldText ?? ""} language={languageForPath(diff.path)} />
                </div>
                <div className="min-w-0 bg-[#effaf4] text-[#17663f]">
                    <HighlightedCode code={diff.newText ?? ""} language={languageForPath(diff.path)} />
                </div>
            </div>
        </section>
    ));
}

export function EditToolPresentation({
    autoOpen,
    children,
    entry,
}: ToolRendererProps & { readonly children: ReactNode }) {
    const disclosure = useToolCallDisclosure(autoOpen);
    return (
        <details aria-label={`Edit: ${entry.title}`} className="group/tool min-w-0" ref={disclosure}>
            <summary
                className="flex min-h-8 w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-sm text-copy-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                title={entry.title}
            >
                <FileDiff aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">{entry.title}</span>
                <ToolCallStatus state={entry.state} />
            </summary>
            <div className="mt-1 ml-5 grid min-w-0 gap-2 text-xs">{children}</div>
        </details>
    );
}
