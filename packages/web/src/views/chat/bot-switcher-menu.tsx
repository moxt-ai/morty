import { Bot, Check, ChevronDown, Plus, Settings, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Popover } from "../../components/ui/popover.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";
import type { BotConnectionStatus, BotOperation } from "../../view-models/chat/bot-chat-home-store.ts";

type BotDialog = { readonly kind: "closed" } | { readonly kind: "rename" } | { readonly kind: "remove" };

export function BotSwitcherMenu({
    activeBot,
    bots,
    connectionStatus,
    operation,
    onConnectAgent,
    onRename,
    onRemove,
    onResetOperation,
    onSelect,
}: {
    readonly activeBot: ManagedBot;
    readonly bots: readonly ManagedBot[];
    readonly connectionStatus: BotConnectionStatus;
    readonly operation: BotOperation;
    readonly onConnectAgent: () => void;
    readonly onRename: (displayName: string, signal: AbortSignal) => Promise<boolean>;
    readonly onRemove: (signal: AbortSignal) => Promise<boolean>;
    readonly onResetOperation: () => void;
    readonly onSelect: (botId: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [dialog, setDialog] = useState<BotDialog>({ kind: "closed" });
    const [name, setName] = useState("");
    const operationController = useRef<AbortController | null>(null);
    useEffect(
        () => () => {
            operationController.current?.abort();
        },
        [],
    );
    const closeDialog = () => {
        operationController.current?.abort();
        operationController.current = null;
        onResetOperation();
        setDialog({ kind: "closed" });
    };
    const begin = () => {
        operationController.current?.abort();
        const controller = new AbortController();
        operationController.current = controller;
        return controller;
    };
    const statusDot =
        connectionStatus.kind === "connected"
            ? "bg-primary"
            : connectionStatus.kind === "connecting"
              ? "animate-pulse bg-amber-500 motion-reduce:animate-none"
              : "bg-muted-foreground/60";
    return (
        <>
            <div className="flex items-center justify-self-end gap-1 sm:mb-6 sm:w-full">
                <Popover.Root
                    onOpenChange={(value) => {
                        setOpen(value);
                    }}
                    open={open}
                >
                    <Popover.Trigger asChild>
                        <button
                            aria-label={`Select Machine. ${activeBot.displayName}, ${connectionStatus.label}`}
                            className="relative flex size-10 justify-self-end items-center justify-center gap-2 rounded-lg text-left outline-none hover:bg-white/70 focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=open]:bg-white/70 sm:h-auto sm:min-w-0 sm:flex-1 sm:justify-self-auto sm:justify-start sm:px-1.5 sm:py-1.5"
                            data-testid={dataTestId.botMenuTrigger}
                            type="button"
                        >
                            <Bot aria-hidden="true" className="size-5 text-muted-foreground sm:hidden" />
                            <span
                                aria-hidden="true"
                                className={`absolute top-1 right-1 size-2 rounded-full ring-2 ring-sidebar sm:hidden ${statusDot}`}
                            />
                            <span
                                aria-hidden="true"
                                className={`hidden size-1.5 shrink-0 rounded-full sm:block ${statusDot}`}
                            />
                            <span className="hidden min-w-0 flex-1 sm:block">
                                <span className="block truncate text-xs font-medium text-foreground">
                                    {activeBot.displayName}
                                </span>
                                <span
                                    className="block text-[11px] leading-4 text-muted-foreground"
                                    data-connection-status={connectionStatus.kind}
                                    data-testid={dataTestId.botConnectionStatus}
                                >
                                    {connectionStatus.label}
                                </span>
                            </span>
                            <ChevronDown
                                aria-hidden="true"
                                className="hidden size-3.5 shrink-0 text-muted-foreground sm:block"
                            />
                        </button>
                    </Popover.Trigger>
                    <Popover.Portal>
                        <Popover.Content
                            align="start"
                            aria-label="Machines"
                            className="z-[100] w-[min(calc(100vw-1.5rem),260px)] rounded-xl border border-border bg-background p-1.5 text-sm shadow-xl"
                            side="bottom"
                            sideOffset={6}
                        >
                            <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                                Machines
                            </p>
                            {bots.map((bot) => (
                                <button
                                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
                                    key={bot.botId}
                                    onClick={() => {
                                        onSelect(bot.botId);
                                        setOpen(false);
                                    }}
                                    type="button"
                                >
                                    <Bot aria-hidden="true" className="size-4 text-muted-foreground" />
                                    <span className="min-w-0 flex-1 truncate">{bot.displayName}</span>
                                    {bot.botId === activeBot.botId && (
                                        <Check aria-hidden="true" className="size-4 text-primary" />
                                    )}
                                </button>
                            ))}
                            {(bots.length > 1 || connectionStatus.kind !== "unpaired") && (
                                <>
                                    <div className="my-1 border-t border-border" />
                                    <button
                                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
                                        data-testid={dataTestId.createBot}
                                        onClick={() => {
                                            setOpen(false);
                                            onConnectAgent();
                                        }}
                                        type="button"
                                    >
                                        <Plus aria-hidden="true" className="size-4" />
                                        Connect another agent
                                    </button>
                                </>
                            )}
                            {operation.kind === "failed" && dialog.kind === "closed" && (
                                <p className="px-2 py-1.5 text-sm text-destructive" role="alert">
                                    {operation.message}
                                </p>
                            )}
                        </Popover.Content>
                    </Popover.Portal>
                </Popover.Root>
                <button
                    type="button"
                    aria-label={`Configure ${activeBot.displayName}`}
                    title={`Configure ${activeBot.displayName}`}
                    onClick={() => {
                        setOpen(false);
                        setName(activeBot.displayName);
                        onResetOperation();
                        setDialog({ kind: "rename" });
                    }}
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-white/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                    <Settings aria-hidden="true" className="size-4" />
                </button>
            </div>
            {dialog.kind === "rename" && (
                <Dialog
                    description={`Choose a new name for ${activeBot.displayName}.`}
                    onClose={closeDialog}
                    title="Rename machine"
                >
                    <form
                        className="mt-5 grid gap-4"
                        onSubmit={(event) => {
                            event.preventDefault();
                            const controller = begin();
                            void onRename(name, controller.signal).then((renamed) => {
                                if (renamed && !controller.signal.aborted) {
                                    closeDialog();
                                }
                            });
                        }}
                    >
                        <label className="grid gap-1.5 text-sm font-medium">
                            Machine name
                            <input
                                autoFocus
                                className="h-10 rounded-lg border border-border bg-background px-3 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                                disabled={operation.kind === "renaming"}
                                maxLength={80}
                                onChange={(event) => setName(event.currentTarget.value)}
                                value={name}
                            />
                        </label>
                        {operation.kind === "failed" && <p className="text-sm text-destructive">{operation.message}</p>}
                        <div className="flex items-center gap-2">
                            {bots.length >= 2 && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    className="mr-auto text-destructive hover:text-destructive"
                                    data-testid={dataTestId.removeBot}
                                    disabled={operation.kind === "renaming"}
                                    onClick={() => {
                                        onResetOperation();
                                        setDialog({ kind: "remove" });
                                    }}
                                >
                                    <Trash2 aria-hidden="true" className="size-4" />
                                    Remove Machine
                                </Button>
                            )}
                            <div className="ml-auto flex gap-2">
                                <Button
                                    disabled={operation.kind === "renaming"}
                                    onClick={closeDialog}
                                    type="button"
                                    variant="ghost"
                                >
                                    Cancel
                                </Button>
                                <Button
                                    disabled={
                                        operation.kind === "renaming" ||
                                        name.trim().length === 0 ||
                                        name.trim() === activeBot.displayName
                                    }
                                    type="submit"
                                >
                                    {operation.kind === "renaming" ? "Renaming…" : "Rename Machine"}
                                </Button>
                            </div>
                        </div>
                    </form>
                </Dialog>
            )}
            {dialog.kind === "remove" && (
                <Dialog
                    description={`Remove ${activeBot.displayName} from Morty? Its sessions will no longer be available in Chat.`}
                    onClose={closeDialog}
                    title="Remove Machine"
                >
                    {operation.kind === "failed" && (
                        <p className="mt-4 text-sm text-destructive">{operation.message}</p>
                    )}
                    <div className="mt-5 flex justify-end gap-2">
                        <Button disabled={operation.kind === "removing"} onClick={closeDialog} variant="ghost">
                            Cancel
                        </Button>
                        <Button
                            data-testid={dataTestId.confirmRemoveBot}
                            disabled={operation.kind === "removing"}
                            onClick={() => {
                                const controller = begin();
                                void onRemove(controller.signal).then((removed) => {
                                    if (removed && !controller.signal.aborted) {
                                        closeDialog();
                                    }
                                });
                            }}
                            variant="destructive"
                        >
                            {operation.kind === "removing" ? "Removing…" : "Remove Machine"}
                        </Button>
                    </div>
                </Dialog>
            )}
        </>
    );
}
