import { Terminal } from "lucide-react";
import { AnsiShellOutput } from "./ansi-shell-output.tsx";
import { ToolCallDisclosure } from "./tool-call-status.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

export function ShellCommandPresentation({
    autoOpen,
    entry,
    response,
}: ToolRendererProps & { readonly response: string }) {
    return (
        <ToolCallDisclosure
            ariaLabel={`Shell command: ${entry.title}`}
            autoOpen={autoOpen}
            icon={<Terminal aria-hidden="true" className="size-4 shrink-0" />}
            state={entry.state}
            title={entry.title}
        >
            {response.length > 0 && (
                <div className="mt-1 ml-5 overflow-hidden rounded-lg bg-black/[0.035]">
                    <AnsiShellOutput output={response} />
                </div>
            )}
        </ToolCallDisclosure>
    );
}
