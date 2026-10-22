import { ChevronDown, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useId, useState } from "react";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import { overlaySurfaceRadiusClassName } from "../ui/overlay-surface.ts";
import { Popover } from "../ui/popover.tsx";
import { useDesktopChatLayout } from "../utils/use-desktop-chat-layout.ts";
import type { ExecutionContext } from "./execution-context.ts";
import { HarnessMark } from "./harness-mark.tsx";

export function SessionExecutionHeaderEnd({
    context,
    showHarnessMark = false,
}: {
    readonly context: ExecutionContext;
    readonly showHarnessMark?: boolean;
}) {
    return (
        <div className="ml-auto flex shrink-0 items-center gap-3">
            <ExecutionContextBar
                context={context}
                layout="header"
                showConnection={false}
                showHarnessMark={showHarnessMark}
            />
            <ExecutionConnectionStatus connection={context.connection} />
        </div>
    );
}

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

function ExecutionConnectionStatus({
    connection,
    className,
}: {
    readonly connection: ExecutionContext["connection"];
    readonly className?: string;
}) {
    return (
        <span
            aria-label="Connection"
            className={cn(
                "flex shrink-0 items-center gap-1.5 text-xs leading-5 text-muted-foreground",
                (connection === "Disconnected" || connection === "Unavailable") && "text-destructive",
                className,
            )}
            role="status"
        >
            <span
                aria-hidden="true"
                className={`size-1.5 rounded-full ${connection === "Connected" ? "bg-primary" : "bg-current"}`}
            />
            {connection}
        </span>
    );
}

export function ExecutionContextBar({
    context,
    layout = "strip",
    showConnection = true,
    showHarnessMark = true,
}: {
    readonly context: ExecutionContext;
    /** `header` places a compact trigger in the session title bar; `strip` is the full-width row. */
    readonly layout?: "header" | "strip";
    readonly showConnection?: boolean;
    /** When the harness mark is shown in the session title, hide it here. */
    readonly showHarnessMark?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const summaryId = useId();
    const desktop = useDesktopChatLayout();
    const headerLayout = layout === "header";
    const trigger = (
        <button
            type="button"
            aria-label="Show execution details"
            aria-describedby={summaryId}
            className={cn(
                "group text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none",
                headerLayout
                    ? "inline-flex max-w-[min(240px,36vw)] items-center gap-1 rounded-md px-2 py-1 text-xs leading-5 text-muted-foreground"
                    : "grid min-h-11 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-2 py-1.5 lg:py-1",
            )}
        >
            <span
                id={summaryId}
                className={cn(
                    "flex min-w-0 items-center gap-2",
                    headerLayout ? "text-xs leading-5" : "col-start-1 row-start-1 text-[13px] leading-5",
                )}
            >
                {showHarnessMark ? (
                    <HarnessMark
                        agentRef={context.agentRef || context.agent}
                        appearance="line"
                        label={context.agent}
                        testId={dataTestId.executionContextHarnessMark}
                    />
                ) : null}
                <span className={cn("min-w-0 truncate", headerLayout ? "font-normal" : "font-medium text-foreground")}>
                    <span className="sr-only">Machine: </span>
                    {context.machine}
                </span>
                {showConnection ? (
                    <ExecutionConnectionStatus className="ml-auto shrink-0" connection={context.connection} />
                ) : null}
            </span>
            <ChevronDown
                aria-hidden="true"
                className={cn(
                    "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none",
                    headerLayout ? "" : "col-start-2 row-start-1",
                )}
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
        <section
            aria-label="Execution context"
            className={cn(headerLayout ? "min-w-0 shrink-0" : "min-w-0 shrink-0 px-1 pb-1 sm:px-4 sm:pb-0")}
        >
            {desktop ? (
                <Popover.Root open={open} onOpenChange={setOpen}>
                    <Popover.Trigger asChild>{trigger}</Popover.Trigger>
                    <Popover.Portal>
                        <Popover.Content
                            role="dialog"
                            aria-label="Execution details"
                            align={headerLayout ? "end" : "start"}
                            side="bottom"
                            sideOffset={6}
                            collisionPadding={12}
                            className={cn(
                                "relative z-50 w-[360px] max-w-[calc(100vw-24px)] border border-border bg-card p-5 shadow-[0_12px_40px_rgba(0,0,0,0.12)] outline-none",
                                overlaySurfaceRadiusClassName,
                            )}
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
