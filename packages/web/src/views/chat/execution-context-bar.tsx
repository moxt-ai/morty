import { Folder, Monitor } from "lucide-react";
import { useState } from "react";
import { Dialog } from "../../components/ui/dialog.tsx";
import type { ExecutionContext } from "../../view-models/chat/execution-context.ts";

export function ExecutionContextBar({ context }: { readonly context: ExecutionContext }) {
    const [directoryOpen, setDirectoryOpen] = useState(false);
    return (
        <section
            aria-label="Execution context"
            className="shrink-0 border-b border-border/50 px-3 py-2 text-xs text-muted-foreground sm:px-6"
        >
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
                <span className="flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]">
                    <Monitor aria-hidden="true" className="size-3.5 shrink-0" />
                    <span>
                        <span className="sr-only">Machine: </span>
                        {context.machine}
                    </span>
                </span>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="text-muted-foreground/70">Agent </span>
                    <span className="font-medium text-foreground">{context.agent}</span>
                </span>
                <span role="status" aria-label="Connection" className="ml-auto flex shrink-0 items-center gap-1.5">
                    <span
                        aria-hidden="true"
                        className={`size-1.5 rounded-full ${context.connection === "Connected" ? "bg-primary" : "bg-muted-foreground"}`}
                    />
                    {context.connection}
                </span>
            </div>
            {context.directory === null ? (
                <p className="mt-1.5">Working directory: {context.directoryPlaceholder}</p>
            ) : (
                <button
                    type="button"
                    aria-label={`Working directory: ${context.directory}`}
                    onClick={() => setDirectoryOpen(true)}
                    className="mt-1 flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <Folder aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="truncate font-mono">{context.directory}</span>
                </button>
            )}
            {directoryOpen && context.directory !== null && (
                <Dialog
                    title="Working directory"
                    description="Execution directory for this conversation."
                    onClose={() => setDirectoryOpen(false)}
                >
                    <p className="select-text font-mono text-sm [overflow-wrap:anywhere]">{context.directory}</p>
                </Dialog>
            )}
        </section>
    );
}
