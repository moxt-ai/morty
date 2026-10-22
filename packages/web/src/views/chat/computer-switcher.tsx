import { Check, ChevronDown, Laptop, Plus } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useStore } from "zustand";
import { dataTestId } from "../../data-testid.ts";
import type { BotConnectionStatus } from "../../view-models/chat/bot-chat-home-store.ts";
import type { ComputerSwitcherModel } from "../../view-models/chat/computer-switcher-store.ts";

export function ComputerSwitcher({
    model,
    name,
    status,
}: {
    readonly model: ComputerSwitcherModel;
    readonly name: string;
    readonly status: BotConnectionStatus;
}) {
    const state = useStore(model.store);
    const active = state.choices.find((choice) => choice.key === model.activeKey);
    const computerName = name || active?.name || "Computer";
    return (
        <DropdownMenu.Root
            onOpenChange={(open) => {
                if (open) {
                    void model.refresh();
                }
            }}
        >
            <DropdownMenu.Trigger asChild>
                <button
                    type="button"
                    aria-label={`Switch computer, ${computerName}`}
                    className="mb-2 flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                    <Laptop aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 items-center justify-between gap-2 sm:flex-col sm:items-start sm:gap-0.5">
                        <span className="min-w-0 truncate text-sm font-medium" title={computerName}>
                            {computerName}
                        </span>
                        <span
                            data-testid={dataTestId.botConnectionStatus}
                            data-connection-status={status.kind}
                            className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                        >
                            <span
                                aria-hidden="true"
                                className={`size-1.5 rounded-full ${status.kind === "connected" ? "bg-primary" : status.kind === "connecting" ? "bg-amber-500" : "bg-muted-foreground/60"}`}
                            />
                            {status.label}
                        </span>
                    </span>
                    <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    align="start"
                    sideOffset={4}
                    className="z-[180] max-h-[min(70dvh,520px)] w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
                    aria-label="Computers"
                >
                    <DropdownMenu.Label className="px-3 py-2 text-xs font-medium text-muted-foreground">
                        Your computers
                    </DropdownMenu.Label>
                    {state.kind === "loading" && (
                        <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
                            Checking connections…
                        </p>
                    )}
                    {state.choices.map((choice) => (
                        <DropdownMenu.Item key={choice.key} asChild>
                            <a
                                href={choice.href}
                                className="flex items-center gap-2 rounded-lg px-3 py-2.5 outline-none data-[highlighted]:bg-accent"
                                aria-current={choice.key === model.activeKey ? "true" : undefined}
                            >
                                <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-medium">{choice.name}</span>
                                    <span
                                        className="block truncate text-xs text-muted-foreground"
                                        title={choice.directory ?? undefined}
                                    >
                                        {choice.directory ??
                                            (choice.lastUsedAt > 0
                                                ? `Last used ${new Date(choice.lastUsedAt).toLocaleString()}`
                                                : "Not opened yet")}
                                    </span>
                                </span>
                                <span
                                    className={`text-xs ${choice.status === "online" ? "text-primary" : "text-muted-foreground"}`}
                                >
                                    {choice.status === "online"
                                        ? "Online"
                                        : choice.status === "offline"
                                          ? "Offline"
                                          : "Unavailable"}
                                </span>
                                {choice.key === model.activeKey && (
                                    <Check className="size-3.5 shrink-0" aria-label="Current computer" />
                                )}
                            </a>
                        </DropdownMenu.Item>
                    ))}
                    <DropdownMenu.Separator className="my-1.5 h-px bg-border" />
                    <DropdownMenu.Item asChild>
                        <a
                            href="/setup"
                            className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm outline-none data-[highlighted]:bg-accent"
                        >
                            <Plus className="size-4" aria-hidden="true" />
                            Connect another computer
                        </a>
                    </DropdownMenu.Item>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}

export function OnlineComputerAlternative({ model }: { readonly model: ComputerSwitcherModel }) {
    const { choices } = useStore(model.store);
    const alternative = choices.find((choice) => choice.key !== model.activeKey && choice.status === "online");
    return alternative === undefined ? null : (
        <a className="mt-2 inline-flex text-xs font-medium text-primary underline" href={alternative.href}>
            Switch to {alternative.name}
        </a>
    );
}
