import { Bot, Check, ChevronDown, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Popover } from "../../components/ui/popover.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";
import type { BotConnectionStatus, BotOperation } from "../../view-models/chat/bot-chat-home-store.ts";

type BotDialog =
    | { readonly kind: "closed" }
    | { readonly kind: "create" }
    | { readonly kind: "rename" }
    | { readonly kind: "remove" };

export function BotSwitcherMenu({
    activeBot,
    bots,
    connectionStatus,
    operation,
    onCreate,
    onPairAgain,
    onRename,
    onRemove,
    onResetOperation,
    onSelect,
}: {
    readonly activeBot: ManagedBot;
    readonly bots: readonly ManagedBot[];
    readonly connectionStatus: BotConnectionStatus;
    readonly operation: BotOperation;
    readonly onCreate: (displayName: string, signal: AbortSignal) => Promise<boolean>;
    readonly onPairAgain: () => void;
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
            <Popover.Root onOpenChange={setOpen} open={open}>
                <Popover.Trigger asChild>
                    <button
                        aria-label={`Select Machine. ${activeBot.displayName}, ${connectionStatus.label}`}
                        className="relative flex size-10 justify-self-end items-center justify-center gap-2 rounded-lg text-left outline-none hover:bg-white/70 focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=open]:bg-white/70 sm:mb-6 sm:h-auto sm:w-full sm:justify-self-auto sm:justify-start sm:px-1.5 sm:py-1.5"
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
                        <div className="my-1 border-t border-border" />
                        {connectionStatus.kind === "disconnected" && (
                            <button
                                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
                                data-testid={dataTestId.pairBotAgain}
                                onClick={() => {
                                    setOpen(false);
                                    onPairAgain();
                                }}
                                type="button"
                            >
                                <RotateCw aria-hidden="true" className="size-4" />
                                Pair again
                            </button>
                        )}
                        <button
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
                            onClick={() => {
                                setOpen(false);
                                setName(activeBot.displayName);
                                onResetOperation();
                                setDialog({ kind: "rename" });
                            }}
                            type="button"
                        >
                            <Pencil aria-hidden="true" className="size-4" />
                            Rename machine
                        </button>
                        <button
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
                            data-testid={dataTestId.createBot}
                            onClick={() => {
                                setOpen(false);
                                setName("");
                                onResetOperation();
                                setDialog({ kind: "create" });
                            }}
                            type="button"
                        >
                            <Plus aria-hidden="true" className="size-4" />
                            Create a new machine
                        </button>
                        {bots.length >= 2 && (
                            <button
                                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring/60"
                                data-testid={dataTestId.removeBot}
                                onClick={() => {
                                    setOpen(false);
                                    onResetOperation();
                                    setDialog({ kind: "remove" });
                                }}
                                type="button"
                            >
                                <Trash2 aria-hidden="true" className="size-4" />
                                Remove Machine
                            </button>
                        )}
                    </Popover.Content>
                </Popover.Portal>
            </Popover.Root>
            {dialog.kind === "create" && (
                <Dialog
                    description="Create a separate Machine before pairing another Runtime. Each Machine keeps its own Runtime binding."
                    onClose={closeDialog}
                    title="Create a new machine"
                >
                    <form
                        className="mt-5 grid gap-4"
                        onSubmit={(event) => {
                            event.preventDefault();
                            const controller = begin();
                            void onCreate(name, controller.signal).then((created) => {
                                if (created && !controller.signal.aborted) {
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
                                data-testid={dataTestId.botNameInput}
                                disabled={operation.kind === "creating"}
                                maxLength={80}
                                onChange={(event) => setName(event.currentTarget.value)}
                                value={name}
                            />
                        </label>
                        {operation.kind === "failed" && <p className="text-sm text-destructive">{operation.message}</p>}
                        <div className="flex justify-end gap-2">
                            <Button
                                disabled={operation.kind === "creating"}
                                onClick={closeDialog}
                                type="button"
                                variant="ghost"
                            >
                                Cancel
                            </Button>
                            <Button
                                data-testid={dataTestId.confirmCreateBot}
                                disabled={operation.kind === "creating" || name.trim().length === 0}
                                type="submit"
                            >
                                {operation.kind === "creating" ? "Creating…" : "Create Machine"}
                            </Button>
                        </div>
                    </form>
                </Dialog>
            )}
            {dialog.kind === "rename" && (
                <Dialog description="Choose a new name for this Machine." onClose={closeDialog} title="Rename machine">
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
                        <div className="flex justify-end gap-2">
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
                    </form>
                </Dialog>
            )}
            {dialog.kind === "remove" && (
                <Dialog
                    description={`Remove ${activeBot.displayName} from this workspace? Its conversations will no longer be available in Chat.`}
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
