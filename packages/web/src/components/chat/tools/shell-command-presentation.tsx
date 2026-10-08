import { Terminal } from "lucide-react";
import { AnsiShellOutput } from "./ansi-shell-output.tsx";
import { ToolCallStatus, useToolCallDisclosure } from "./tool-call-status.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

export function ShellCommandPresentation({
    autoOpen,
    entry,
    response,
}: ToolRendererProps & { readonly response: string }) {
    const disclosure = useToolCallDisclosure(autoOpen);
    return (
        <details aria-label={`Shell command: ${entry.title}`} className="group/tool min-w-0" ref={disclosure}>
            <summary
                className="flex min-h-8 w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-sm text-copy-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                title={entry.title}
            >
                <Terminal aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">{entry.title}</span>
                <ToolCallStatus state={entry.state} />
            </summary>
            {response.length > 0 && (
                <div className="mt-1 ml-5 overflow-hidden rounded-lg bg-black/[0.035]">
                    <AnsiShellOutput output={response} />
                </div>
            )}
        </details>
    );
}
