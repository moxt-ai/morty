import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { dataTestId } from "../../data-testid.ts";
import type { ExecutionContext } from "./execution-context.ts";

function ExecutionDetails({ context }: { readonly context: ExecutionContext }) {
    return (
        <dl className="grid gap-5 text-[13px] leading-5">
            <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-4">
                <dt className="text-muted-foreground">Agent</dt>
                <dd className="font-medium text-foreground [overflow-wrap:anywhere]">{context.agent}</dd>
            </div>
            <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-4">
                <dt className="text-muted-foreground">Computer</dt>
                <dd className="text-foreground [overflow-wrap:anywhere]">{context.machine}</dd>
            </div>
            <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-4">
                <dt className="text-muted-foreground">Session connection</dt>
                <dd className="text-foreground">{context.connection}</dd>
            </div>
            <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-4">
                <dt className="text-muted-foreground">Computer status</dt>
                <dd className="text-foreground">
                    {context.computerStatus}
                    {context.lastConfirmed !== null && (
                        <span className="mt-1 block text-xs text-muted-foreground">{context.lastConfirmed}</span>
                    )}
                </dd>
            </div>
            <div className="grid gap-2.5">
                <dt className="text-muted-foreground">Working directory</dt>
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
                    className="fixed inset-x-0 bottom-0 z-[191] max-h-[85dvh] overflow-y-auto rounded-t-3xl border border-border bg-card px-6 pt-6 pb-[max(24px,env(safe-area-inset-bottom))] shadow-xl outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[400px] sm:max-w-[calc(100vw-24px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:pb-6"
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        returnFocus();
                    }}
                >
                    <Dialog.Title className="mb-5 pr-8 text-16 font-semibold">Execution details</Dialog.Title>
                    <Dialog.Description className="sr-only">
                        Computer availability, session connection, Agent, and working directory.
                    </Dialog.Description>
                    <Dialog.Close
                        className="absolute right-2 top-2 flex size-11 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
                        aria-label="Close execution details"
                    >
                        <X aria-hidden="true" className="size-4" />
                    </Dialog.Close>
                    <ExecutionDetails context={context} />
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
