import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { cn } from "@/lib/utils";
import { dataTestId } from "../../data-testid.ts";
import { executionDetailsDialogDesktopWidthClassName, overlaySurfaceRadiusClassName } from "../ui/overlay-surface.ts";
import type { ExecutionContext } from "./execution-context.ts";
import { HarnessMark } from "./harness-mark.tsx";

function computerStatusDotClassName(status: ExecutionContext["computerStatus"]): string {
    switch (status) {
        case "Online":
            return "size-2 bg-emerald-500";
        case "Checking availability":
            return "size-1.5 animate-pulse bg-amber-500 motion-reduce:animate-none";
        case "Offline":
        case "Not paired":
        case "Status unavailable":
            return "size-1.5 bg-muted-foreground/60";
    }
}

const executionDetailsTermClassName = "shrink-0 whitespace-nowrap text-muted-foreground";

function ExecutionDetails({ context }: { readonly context: ExecutionContext }) {
    return (
        <dl className="grid gap-5 text-[13px] leading-5">
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-5">
                <dt className={executionDetailsTermClassName}>Agent</dt>
                <dd className="min-w-0 font-medium text-foreground">
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                        <HarnessMark
                            agentRef={context.agentRef}
                            appearance="line"
                            label={context.agent}
                            testId={dataTestId.executionDetailsHarnessMark}
                        />
                        <span className="min-w-0 [overflow-wrap:anywhere]">{context.agent}</span>
                    </span>
                </dd>
                <dt className={executionDetailsTermClassName}>Computer</dt>
                <dd className="text-foreground [overflow-wrap:anywhere]">{context.machine}</dd>
                <dt className={executionDetailsTermClassName}>Session connection</dt>
                <dd className="text-foreground">{context.connection}</dd>
                <dt className={executionDetailsTermClassName}>Computer status</dt>
                <dd className="text-foreground">
                    <span className="inline-flex items-center gap-1.5">
                        <span
                            aria-hidden="true"
                            className={cn("shrink-0 rounded-full", computerStatusDotClassName(context.computerStatus))}
                        />
                        {context.computerStatus}
                    </span>
                    {context.lastConfirmed !== null && (
                        <span className="mt-1 block text-xs text-muted-foreground">{context.lastConfirmed}</span>
                    )}
                </dd>
            </div>
            <div className="grid gap-2.5">
                <dt className={executionDetailsTermClassName}>Working directory</dt>
                <dd
                    data-testid={dataTestId.executionDirectory}
                    className="select-text rounded-xl bg-muted/70 px-3.5 py-3 font-mono text-xs leading-5 text-foreground [overflow-wrap:anywhere]"
                >
                    {context.directory ?? context.directoryPlaceholder}
                </dd>
            </div>
        </dl>
    );
}

export function ExecutionDetailsDialog({
    context,
    open,
    onOpenChange,
    returnFocus,
}: {
    readonly context: ExecutionContext;
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly returnFocus: () => void;
}) {
    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[190] bg-black/25" />
                <Dialog.Content
                    className={cn(
                        "fixed inset-x-0 bottom-0 z-[191] max-h-[85dvh] overflow-y-auto rounded-t-[28px] border border-border bg-card px-6 pt-6 pb-[max(24px,env(safe-area-inset-bottom))] shadow-xl outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:max-w-[calc(100vw-24px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:pb-6",
                        executionDetailsDialogDesktopWidthClassName,
                        overlaySurfaceRadiusClassName,
                        "sm:rounded-overlay",
                    )}
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        returnFocus();
                    }}
                >
                    <div className="mb-5 flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                            <Dialog.Title className="text-16 font-semibold leading-6">Execution details</Dialog.Title>
                            <Dialog.Description className="sr-only">
                                Computer availability, session connection, Agent, and working directory.
                            </Dialog.Description>
                        </div>
                        <Dialog.Close
                            className="mt-2.5 mr-2.5 flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
                            aria-label="Close execution details"
                        >
                            <X aria-hidden="true" className="size-4" />
                        </Dialog.Close>
                    </div>
                    <ExecutionDetails context={context} />
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
