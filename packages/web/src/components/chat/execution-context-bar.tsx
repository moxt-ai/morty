import { ChevronDown, Folder, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useId, useState } from "react";
import { dataTestId } from "../../data-testid.ts";
import { Popover } from "../ui/popover.tsx";
import { useDesktopChatLayout } from "../utils/use-desktop-chat-layout.ts";
import type { ExecutionContext } from "./execution-context.ts";

function ExecutionDetails({ context }: { readonly context: ExecutionContext }) {
    return (
        <dl className="grid gap-5 text-[13px] leading-5">
            <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-4">
                <dt className="text-muted-foreground">Agent</dt>
                <dd className="font-medium text-foreground [overflow-wrap:anywhere]">{context.agent}</dd>
            </div>
            <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-4">
                <dt className="text-muted-foreground">Machine</dt>
                <dd className="text-foreground [overflow-wrap:anywhere]">{context.machine}</dd>
            </div>
            <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-4">
                <dt className="text-muted-foreground">Session</dt>
                <dd className="text-foreground">{context.connection}</dd>
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

export function ExecutionContextBar({ context }: { readonly context: ExecutionContext }) {
    const [open, setOpen] = useState(false);
    const summaryId = useId();
    const desktop = useDesktopChatLayout();
    const trigger = (
        <button
            type="button"
            aria-label="Show execution details"
            aria-describedby={summaryId}
            className="group grid min-h-11 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none lg:py-1"
        >
            <span id={summaryId} className="contents">
                <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-2 text-[13px] leading-5">
                    <span className="max-w-[45%] truncate font-medium text-foreground lg:max-w-40">
                        <span className="sr-only">Agent </span>
                        {context.agent}
                    </span>
                    <span aria-hidden="true" className="text-border">
                        /
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                        <Folder aria-hidden="true" className="size-3.5 shrink-0" />
                        <span className="sr-only">Working directory: </span>
                        <span className="truncate lg:max-w-48">{context.directoryName}</span>
                    </span>
                </span>
                {context.connection !== "Connected" && (
                    <span
                        className={`col-span-2 col-start-1 row-start-2 text-xs leading-5 ${context.connection === "Disconnected" || context.connection === "Unavailable" ? "text-destructive" : "text-muted-foreground"}`}
                    >
                        Session: {context.connection}
                    </span>
                )}
            </span>
            <ChevronDown
                aria-hidden="true"
                className="col-start-2 row-start-1 size-3.5 text-muted-foreground/70 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            />
        </button>
    );
    const close = (
        <button
            type="button"
            aria-label="Close execution details"
            onClick={() => setOpen(false)}
            className="absolute right-2 top-2 flex size-11 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
        >
            <X aria-hidden="true" className="size-4" />
        </button>
    );
    return (
        <section aria-label="Execution context" className="min-w-0 shrink-0 px-1 pb-1 sm:px-4 sm:pb-0">
            <span role="status" aria-label="Connection" className="sr-only">
                {context.connection}
            </span>
            {desktop ? (
                <Popover.Root open={open} onOpenChange={setOpen}>
                    <Popover.Trigger asChild>{trigger}</Popover.Trigger>
                    <Popover.Portal>
                        <Popover.Content
                            role="dialog"
                            aria-label="Execution details"
                            align="start"
                            side="bottom"
                            sideOffset={6}
                            collisionPadding={12}
                            className="relative z-50 w-[360px] max-w-[calc(100vw-24px)] rounded-2xl border border-border bg-card p-5 shadow-[0_12px_40px_rgba(0,0,0,0.12)] outline-none"
                        >
                            <h3 className="mb-5 pr-8 text-16 font-semibold">Execution details</h3>
                            {close}
                            <ExecutionDetails context={context} />
                        </Popover.Content>
                    </Popover.Portal>
                </Popover.Root>
            ) : (
                <Dialog.Root open={open} onOpenChange={setOpen}>
                    <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
                    <Dialog.Portal>
                        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25" />
                        <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 max-h-[80dvh] overflow-y-auto rounded-t-3xl border-t border-border/50 bg-card px-6 pt-6 pb-[max(24px,env(safe-area-inset-bottom))] shadow-[0_-8px_40px_rgba(0,0,0,0.08)] outline-none">
                            <Dialog.Title className="mb-5 pr-8 text-16 font-semibold">Execution details</Dialog.Title>
                            <Dialog.Description className="sr-only">
                                Machine, Agent, and working directory for this conversation.
                            </Dialog.Description>
                            {close}
                            <ExecutionDetails context={context} />
                        </Dialog.Content>
                    </Dialog.Portal>
                </Dialog.Root>
            )}
        </section>
    );
}
