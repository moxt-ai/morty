import { Check, ChevronDown, Laptop, LoaderCircle, Plus } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useStore } from "zustand";
import { cn } from "@/lib/utils";
import {
    type OverlayContentOpenAutoFocus,
    overlayMenuSeparatorClassName,
    overlaySurfacePanelClassName,
    overlaySurfaceRadiusClassName,
    overlayTriggerOffsetPx,
    preventOverlayOpenAutoFocus,
} from "../../components/ui/overlay-surface.ts";
import { dataTestId } from "../../data-testid.ts";
import type { BotConnectionStatus } from "../../view-models/chat/bot-chat-home-store.ts";
import type { ComputerChoice, ComputerSwitcherModel } from "../../view-models/chat/computer-switcher-store.ts";

export function BotConnectionStatusIndicator({
    status,
    className,
    testId,
}: {
    readonly status: BotConnectionStatus;
    readonly className?: string;
    readonly testId?: string;
}) {
    return (
        <span
            data-testid={testId}
            data-connection-status={status.kind}
            className={cn("flex shrink-0 items-center justify-end gap-1.5", className)}
            role="status"
        >
            {status.kind === "connected" ? (
                <>
                    <span aria-hidden="true" className="size-2 rounded-full bg-emerald-500" />
                    <span className="sr-only">Online</span>
                </>
            ) : (
                <>
                    <span
                        aria-hidden="true"
                        className={`size-1.5 rounded-full ${
                            status.kind === "connecting"
                                ? "animate-pulse bg-amber-500 motion-reduce:animate-none"
                                : "bg-muted-foreground/60"
                        }`}
                    />
                    <span
                        className={`whitespace-nowrap text-xs ${
                            status.kind === "connecting" ? "text-amber-600" : "text-muted-foreground"
                        }`}
                    >
                        {status.kind === "connecting" ? "Connecting" : "Offline"}
                    </span>
                </>
            )}
        </span>
    );
}

const openedDate = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short" });

const computerMenuLabelClassName = "px-3 pb-1 text-xs font-medium text-copy-tertiary";

type ComputerMenuEntries =
    | { readonly kind: "flat"; readonly choices: readonly ComputerChoice[] }
    | {
          readonly kind: "grouped";
          readonly available: readonly ComputerChoice[];
          readonly unavailable: readonly ComputerChoice[];
      };

function computerMenuEntries(choices: readonly ComputerChoice[], activeKey: string): ComputerMenuEntries {
    const current = choices.find((choice) => choice.key === activeKey);
    const others = choices.filter((choice) => choice.key !== activeKey);
    const available = [
        ...(current?.status === "online" ? [current] : []),
        ...others.filter((choice) => choice.status === "online"),
    ];
    const unavailable = [
        ...(current !== undefined && current.status !== "online" ? [current] : []),
        ...others.filter((choice) => choice.status !== "online"),
    ];
    if (choices.length > 1 && available.length > 0 && unavailable.length > 0) {
        return { kind: "grouped", available, unavailable };
    }
    return {
        kind: "flat",
        choices: [
            ...(current === undefined ? [] : [current]),
            ...others.filter((choice) => choice.status === "online"),
            ...others.filter((choice) => choice.status !== "online"),
        ],
    };
}

function ComputerChoiceDetail({ choice }: { readonly choice: ComputerChoice }) {
    const directory = choice.directoryName;
    const directoryTitle = choice.directory ?? undefined;
    if (choice.status === "online") {
        if (directory !== null) {
            return (
                <span className="block truncate text-xs text-morty-text-3" title={directoryTitle}>
                    {directory}
                </span>
            );
        }
        if (choice.lastUsedAt > 0) {
            return (
                <span className="block truncate text-xs text-morty-text-3">
                    {`Last opened ${openedDate.format(new Date(choice.lastUsedAt))}`}
                </span>
            );
        }
        return null;
    }
    const statusLabel = choice.status === "offline" ? "Offline" : "Unavailable";
    if (directory === null) {
        return <span className="block truncate text-xs text-morty-text-3">{statusLabel}</span>;
    }
    return (
        <span className="block truncate text-xs text-morty-text-3">
            {statusLabel}
            {" · "}
            <span title={directoryTitle}>{directory}</span>
        </span>
    );
}

const computerChoiceRowClassName = "grid grid-cols-[0.5rem_minmax(0,1fr)_1rem] items-start outline-none";

const computerListChoiceClassName =
    "gap-x-4 py-2.5 pr-4 pl-6 hover:bg-morty-fill-opacity-2 active:bg-morty-fill-opacity-3 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60";

function ComputerChoiceContent({
    choice,
    current,
    titleClassName = "text-14",
}: {
    readonly choice: ComputerChoice;
    readonly current: boolean;
    readonly titleClassName?: string;
}) {
    return (
        <>
            <span className="mt-2 flex size-2 shrink-0 items-center justify-center">
                <span
                    aria-hidden="true"
                    className={cn(
                        "rounded-full",
                        choice.status === "online" ? "size-2 bg-emerald-500" : "size-1.5 bg-muted-foreground/60",
                    )}
                />
                {choice.status === "online" ? <span className="sr-only">Online</span> : null}
            </span>
            <span className="min-w-0">
                <span className={cn("block truncate font-medium", titleClassName)} title={choice.name}>
                    {choice.name}
                </span>
                <ComputerChoiceDetail choice={choice} />
            </span>
            <span className="mt-1 flex size-4 items-center justify-center" aria-hidden="true">
                {current ? <Check className="size-3.5" /> : null}
            </span>
        </>
    );
}

function ComputerChoiceItem({ activeKey, choice }: { readonly activeKey: string; readonly choice: ComputerChoice }) {
    const current = choice.key === activeKey;
    return (
        <DropdownMenu.Item textValue={choice.name} asChild>
            <a
                href={choice.href}
                className={cn(
                    computerChoiceRowClassName,
                    "gap-x-2.5 rounded-md px-3 py-2 data-[highlighted]:bg-accent",
                )}
                aria-current={current ? "true" : undefined}
            >
                <ComputerChoiceContent choice={choice} current={current} />
            </a>
        </DropdownMenu.Item>
    );
}

function ComputerChoiceList({
    activeKey,
    choices,
}: {
    readonly activeKey: string;
    readonly choices: readonly ComputerChoice[];
}) {
    const entries = computerMenuEntries(choices, activeKey);
    if (entries.kind === "grouped") {
        return (
            <>
                <DropdownMenu.Group>
                    <DropdownMenu.Label className={computerMenuLabelClassName}>Available</DropdownMenu.Label>
                    {entries.available.map((choice) => (
                        <ComputerChoiceItem activeKey={activeKey} choice={choice} key={choice.key} />
                    ))}
                </DropdownMenu.Group>
                <DropdownMenu.Group>
                    <DropdownMenu.Label className={computerMenuLabelClassName}>Unavailable</DropdownMenu.Label>
                    {entries.unavailable.map((choice) => (
                        <ComputerChoiceItem activeKey={activeKey} choice={choice} key={choice.key} />
                    ))}
                </DropdownMenu.Group>
            </>
        );
    }
    return entries.choices.map((choice) => (
        <ComputerChoiceItem activeKey={activeKey} choice={choice} key={choice.key} />
    ));
}

const sidebarNavOptionTriggerClassName =
    "flex w-full items-center gap-2.5 rounded-lg px-[10px] py-2 text-left text-[13px] font-medium text-copy-secondary outline-none transition-[background-color,color] duration-150 hover:bg-morty-fill-opacity-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 active:bg-morty-fill-opacity-3 active:text-foreground motion-reduce:transition-none";

export const mobileDrawerCardClassName = "flex flex-col overflow-hidden rounded-lg bg-morty-fill-white text-foreground";

export const mobileDrawerOptionDividerClassName = "[&>*+*]:border-t-[0.5px] [&>*+*]:border-black/[0.06]";

export const mobileDrawerCardRowClassName =
    "flex h-12 w-full items-center gap-3 px-4 text-left text-[15px] font-medium text-foreground outline-none transition-colors hover:bg-morty-fill-opacity-2 active:bg-morty-fill-opacity-3 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

function orderedComputerChoices(choices: readonly ComputerChoice[], activeKey: string): readonly ComputerChoice[] {
    const entries = computerMenuEntries(choices, activeKey);
    return entries.kind === "grouped" ? [...entries.available, ...entries.unavailable] : entries.choices;
}

function ComputerListChoice({ activeKey, choice }: { readonly activeKey: string; readonly choice: ComputerChoice }) {
    const current = choice.key === activeKey;
    return (
        <a
            href={choice.href}
            aria-current={current ? "true" : undefined}
            className={cn(computerChoiceRowClassName, computerListChoiceClassName)}
        >
            <ComputerChoiceContent choice={choice} current={current} titleClassName="text-[15px]" />
        </a>
    );
}

function ComputerListChoices({
    activeKey,
    choices,
}: {
    readonly activeKey: string;
    readonly choices: readonly ComputerChoice[];
}) {
    const entries = computerMenuEntries(choices, activeKey);
    if (entries.kind === "grouped") {
        return (
            <div className="flex flex-col">
                <p className="px-4 pt-2 pb-1 text-xs font-medium text-copy-tertiary">Available</p>
                <div className={mobileDrawerOptionDividerClassName}>
                    {entries.available.map((choice) => (
                        <ComputerListChoice activeKey={activeKey} choice={choice} key={choice.key} />
                    ))}
                </div>
                <p className="px-4 pt-2 pb-1 text-xs font-medium text-copy-tertiary">Unavailable</p>
                <div className={mobileDrawerOptionDividerClassName}>
                    {entries.unavailable.map((choice) => (
                        <ComputerListChoice activeKey={activeKey} choice={choice} key={choice.key} />
                    ))}
                </div>
            </div>
        );
    }
    return (
        <div className={mobileDrawerOptionDividerClassName}>
            {entries.choices.map((choice) => (
                <ComputerListChoice activeKey={activeKey} choice={choice} key={choice.key} />
            ))}
        </div>
    );
}

export function ComputerSwitcher({
    model,
    name,
    status,
    layout = "block",
}: {
    readonly model: ComputerSwitcherModel;
    readonly name: string;
    readonly status: BotConnectionStatus;
    readonly layout?: "block" | "header" | "list";
}) {
    const state = useStore(model.store);
    const active = state.choices.find((choice) => choice.key === model.activeKey);
    const computerName = name || active?.name || "Computer";
    if (layout === "list") {
        const choices = orderedComputerChoices(state.choices, model.activeKey);
        return (
            <nav aria-label="Computers" className="flex w-full min-w-0 flex-col">
                <p className="px-4 pt-3 pb-1 text-[13px] font-medium text-morty-text-3">Computers</p>
                <div className={cn("flex w-full min-w-0 flex-col", mobileDrawerOptionDividerClassName)}>
                    {state.kind === "loading" && choices.length === 0 ? (
                        <span className={cn(computerChoiceRowClassName, computerListChoiceClassName)}>
                            <span className="mt-2 flex size-2 shrink-0 items-center justify-center">
                                <span
                                    aria-hidden="true"
                                    className={cn(
                                        "rounded-full",
                                        status.kind === "connected"
                                            ? "size-2 bg-emerald-500"
                                            : "size-1.5 bg-muted-foreground/60",
                                    )}
                                />
                                {status.kind === "connected" ? <span className="sr-only">Online</span> : null}
                            </span>
                            <span className="min-w-0">
                                <span className="block truncate text-[15px] font-medium" title={computerName}>
                                    {computerName}
                                </span>
                                {status.kind === "connected" ? null : (
                                    <span className="block truncate text-xs text-morty-text-3">
                                        {status.kind === "connecting" ? "Connecting" : "Offline"}
                                    </span>
                                )}
                            </span>
                            <span className="mt-1 flex size-4 items-center justify-center" aria-hidden="true">
                                <Check className="size-3.5" />
                            </span>
                        </span>
                    ) : (
                        <ComputerListChoices activeKey={model.activeKey} choices={choices} />
                    )}
                    <a href="/setup" className={mobileDrawerCardRowClassName}>
                        <Plus aria-hidden="true" className="size-5 shrink-0 text-copy-secondary" />
                        Connect another computer
                    </a>
                </div>
            </nav>
        );
    }
    const inHeader = layout === "header";
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
                    className={
                        inHeader
                            ? "flex max-w-[120px] min-w-0 items-center gap-0.5 overflow-hidden rounded-lg px-3 py-1.5 text-left text-12 outline-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-muted-foreground"
                            : sidebarNavOptionTriggerClassName
                    }
                >
                    {inHeader ? (
                        <>
                            <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-1.5">
                                <BotConnectionStatusIndicator status={status} testId={dataTestId.botConnectionStatus} />
                                <span
                                    className="max-w-[100px] min-w-0 truncate text-12 font-normal"
                                    title={computerName}
                                >
                                    {computerName}
                                </span>
                            </span>
                            <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                        </>
                    ) : (
                        <>
                            <Laptop aria-hidden="true" className="size-4 shrink-0" />
                            <span className="min-w-0 flex-1 truncate" title={computerName}>
                                {computerName}
                            </span>
                            <BotConnectionStatusIndicator status={status} testId={dataTestId.botConnectionStatus} />
                            <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-copy-secondary" />
                        </>
                    )}
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    align="start"
                    sideOffset={overlayTriggerOffsetPx}
                    {...({ onOpenAutoFocus: preventOverlayOpenAutoFocus } satisfies OverlayContentOpenAutoFocus)}
                    className={cn(
                        "z-[180] flex max-h-[min(70dvh,520px)] w-[min(calc(100vw-1.5rem),320px)] animate-cloud-enter flex-col overflow-hidden p-1.5 text-sm text-foreground outline-none motion-reduce:animate-none",
                        overlaySurfacePanelClassName,
                        overlaySurfaceRadiusClassName,
                    )}
                    aria-label="Computers"
                >
                    <DropdownMenu.Label className="flex shrink-0 items-center justify-between gap-2 px-3 pt-1 pb-3 text-16 font-semibold text-copy-tertiary">
                        Computers
                        {state.kind === "loading" && state.choices.length > 0 ? (
                            <span className="inline-flex shrink-0" role="status">
                                <LoaderCircle
                                    aria-hidden="true"
                                    className="size-3.5 animate-spin text-copy-tertiary motion-reduce:animate-none"
                                />
                                <span className="sr-only">Checking connections…</span>
                            </span>
                        ) : null}
                    </DropdownMenu.Label>
                    <div className="flex min-h-0 flex-col overflow-y-auto">
                        {state.kind === "loading" && state.choices.length === 0 ? (
                            <p className="px-3 py-2 text-copy-tertiary" role="status">
                                Checking connections…
                            </p>
                        ) : (
                            <ComputerChoiceList activeKey={model.activeKey} choices={state.choices} />
                        )}
                    </div>
                    <DropdownMenu.Separator className={cn("-mx-1.5 my-1.5", overlayMenuSeparatorClassName)} />
                    <DropdownMenu.Item asChild>
                        <a
                            href="/setup"
                            className="flex h-9 cursor-pointer items-center gap-2 rounded-full px-3 outline-none data-[highlighted]:bg-accent"
                        >
                            <Plus aria-hidden="true" className="size-4" />
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
