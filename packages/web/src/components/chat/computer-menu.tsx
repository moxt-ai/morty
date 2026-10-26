import {
    Check,
    ChevronDown,
    CircleAlert,
    CircleHelp,
    CirclePause,
    Info,
    Laptop,
    LoaderCircle,
    Plus,
    WifiOff,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useId, useRef, useState } from "react";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import type { BotConnectionStatus } from "../../view-models/chat/bot-chat-home-store.ts";
import type { ComputerChoice } from "../../view-models/chat/computer-switcher-store.ts";
import type { ExecutionContext } from "./execution-context.ts";
import { ExecutionDetailsDialog } from "./execution-details-dialog.tsx";

export function ComputerMenu({
    choices,
    loading,
    activeKey,
    name,
    status,
    context,
    compact,
    onOpen,
}: {
    readonly choices: readonly ComputerChoice[];
    readonly loading: boolean;
    readonly activeKey: string;
    readonly name: string;
    readonly status: BotConnectionStatus;
    readonly context: ExecutionContext;
    readonly compact: boolean;
    readonly onOpen: () => void;
}) {
    const active = choices.find((choice) => choice.key === activeKey);
    const computerName = name || active?.name || "Computer";
    const [detailsOpen, setDetailsOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const descriptionId = useId();
    const indicator = context.indicator;
    const StatusIcon =
        indicator.kind === "recovering"
            ? LoaderCircle
            : indicator.kind === "offline"
              ? WifiOff
              : indicator.kind === "failed"
                ? CircleAlert
                : indicator.kind === "closed"
                  ? CirclePause
                  : CircleHelp;
    return (
        <>
            <DropdownMenu.Root
                onOpenChange={(open) => {
                    if (open) {
                        onOpen();
                    }
                }}
            >
                <DropdownMenu.Trigger asChild>
                    <button
                        ref={trigger}
                        type="button"
                        aria-describedby={descriptionId}
                        data-testid={dataTestId.botConnectionStatus}
                        data-connection-status={status.kind}
                        aria-label={`Switch computer, ${computerName}`}
                        className={cn(
                            "flex min-h-11 min-w-0 items-center gap-1.5 rounded-lg px-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60",
                            compact ? "max-w-[132px] shrink-0" : "mb-2 w-full",
                        )}
                    >
                        <Laptop aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={computerName}>
                            {computerName}
                        </span>
                        {indicator.kind === "ready" ? (
                            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />
                        ) : (
                            <StatusIcon
                                aria-hidden="true"
                                className={cn(
                                    "size-3.5 shrink-0",
                                    indicator.kind === "failed" ? "text-destructive" : "text-muted-foreground",
                                    indicator.kind === "recovering" && "animate-spin motion-reduce:animate-none",
                                )}
                            />
                        )}
                        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                    </button>
                </DropdownMenu.Trigger>
                <span id={descriptionId} className="sr-only">
                    {indicator.label}
                </span>
                <DropdownMenu.Portal>
                    <DropdownMenu.Content
                        align={compact ? "end" : "start"}
                        onCloseAutoFocus={(event) => {
                            if (detailsOpen) {
                                event.preventDefault();
                            }
                        }}
                        sideOffset={4}
                        className="z-[180] max-h-[min(70dvh,520px)] w-88 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
                        aria-label="Computers"
                    >
                        <DropdownMenu.Label className="px-3 py-2 text-xs font-medium text-muted-foreground">
                            Computers
                        </DropdownMenu.Label>
                        {loading && (
                            <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
                                Checking connections…
                            </p>
                        )}
                        {choices.map((choice) => (
                            <DropdownMenu.Item key={choice.key} textValue={choice.name} asChild>
                                <a
                                    href={choice.href}
                                    className="grid min-h-14 grid-cols-[1rem_minmax(0,1fr)_auto_1rem] items-center gap-2 rounded-sm px-3 py-2.5 outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-muted-foreground data-[highlighted]:bg-accent"
                                    aria-current={choice.key === activeKey ? "true" : undefined}
                                >
                                    <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm font-medium [overflow-wrap:anywhere]">
                                            {choice.name}
                                        </span>
                                        <span
                                            className="block truncate text-xs text-muted-foreground"
                                            title={choice.directory ?? undefined}
                                        >
                                            {choice.directoryName ??
                                                (choice.lastUsedAt > 0
                                                    ? `Last used ${new Date(choice.lastUsedAt).toLocaleString()}`
                                                    : "Not opened yet")}
                                        </span>
                                    </span>
                                    <span className="max-w-24 text-right text-xs text-muted-foreground">
                                        {choice.key === activeKey
                                            ? context.computerStatus
                                            : loading
                                              ? "Checking…"
                                              : choice.status === "online"
                                                ? "Online"
                                                : choice.status === "offline"
                                                  ? "Offline"
                                                  : "Unavailable"}
                                    </span>
                                    <span className="flex size-4 items-center justify-center" aria-hidden="true">
                                        {choice.key === activeKey && <Check className="size-3.5" />}
                                    </span>
                                </a>
                            </DropdownMenu.Item>
                        ))}
                        <div className="px-3 py-2 text-xs text-muted-foreground" role="status">
                            {indicator.label}
                        </div>
                        <DropdownMenu.Item
                            className="flex min-h-11 items-center gap-2 rounded-sm px-3 py-2.5 text-sm outline-none data-[highlighted]:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
                            onSelect={() => setDetailsOpen(true)}
                        >
                            <Info aria-hidden="true" className="size-4" />
                            Execution details
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator className="my-1.5 h-px bg-border" />
                        <DropdownMenu.Item asChild>
                            <a
                                href="/setup"
                                className="flex min-h-11 items-center gap-2 rounded-sm px-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-muted-foreground data-[highlighted]:bg-accent"
                            >
                                <Plus className="size-4 shrink-0" aria-hidden="true" />
                                Connect another computer
                            </a>
                        </DropdownMenu.Item>
                    </DropdownMenu.Content>
                </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <ExecutionDetailsDialog
                context={context}
                open={detailsOpen}
                onOpenChange={setDetailsOpen}
                returnFocus={() => trigger.current?.focus()}
            />
        </>
    );
}
