import { Search } from "lucide-react";
import { ToolCallDisclosure } from "./tool-call-status.tsx";
import { toolTextContent } from "./tool-display-content.ts";
import type { ToolRendererProps } from "./tool-renderer.ts";

export function SearchToolPresentation({ autoOpen, entry, path }: ToolRendererProps & { readonly path: string }) {
    const result = toolTextContent(entry.content) ?? entry.output;
    return (
        <ToolCallDisclosure
            ariaLabel={`Search: ${entry.title}`}
            autoOpen={autoOpen}
            icon={<Search aria-hidden="true" className="size-4 shrink-0" />}
            state={entry.state}
            title={entry.title}
        >
            <div className="mt-1 ml-5 grid min-w-0 gap-2 text-xs">
                <div className="truncate font-mono text-copy-secondary" title={path}>
                    {path}
                </div>
                {result.length > 0 && (
                    <div className="grid gap-1">
                        <span className="font-medium text-copy-tertiary">Results</span>
                        <pre className="max-h-96 overflow-auto rounded-lg bg-black/[0.035] p-2 whitespace-pre-wrap">
                            {result}
                        </pre>
                    </div>
                )}
            </div>
        </ToolCallDisclosure>
    );
}
