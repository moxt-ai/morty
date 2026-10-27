import { Check, ChevronDown, ChevronRight, Laptop, LoaderCircle, Plus } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useStore } from "zustand";
import { cn } from "@/lib/utils";
import { ComputerExecutionDetails } from "../../components/chat/computer-execution-details.tsx";
import type { ExecutionContext } from "../../components/chat/execution-context.ts";
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

function BotConnectionStatusIndicator({
    status,
    className,
}: {
    readonly status: BotConnectionStatus;
    readonly className?: string;
}) {
    return (
        <span className={cn("flex shrink-0 items-center justify-end", className)} role="status">
            <span
                aria-hidden="true"
                className={cn(
                    "size-2 rounded-full",
                    status.kind === "connected"
                        ? "bg-emerald-500"
                        : status.kind === "connecting"
                          ? "animate-pulse bg-amber-500 motion-reduce:animate-none"
                          : "bg-muted-foreground/60",
                )}
            />
            {status.kind === "connected" ? null : (
                <span className="sr-only">{status.kind === "connecting" ? "Connecting" : "Offline"}</span>
            )}
        </span>
    );
}

const openedDate = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short" });

const computerMenuLabelClassName = "px-3 pt-1 pb-1 text-xs font-normal text-morty-text-3";

interface ComputerSections {
    readonly current: ComputerChoice | null;
    readonly others: readonly ComputerChoice[];
}

function computerSections(choices: readonly ComputerChoice[], activeKey: string): ComputerSections {
    const current = choices.find((choice) => choice.key === activeKey) ?? null;
    const others = choices.filter((choice) => choice.key !== activeKey);
    return {
        current,
        others: [
            ...others.filter((choice) => choice.status === "online"),
            ...others.filter((choice) => choice.status !== "online"),
        ],
    };
}

const computerChoiceDetailClassName = "block truncate text-xs text-morty-text-3";

const computerListChoiceDetailClassName = "block truncate text-[13px] text-morty-text-3";

function ComputerChoiceDetail({
    choice,
    className = computerChoiceDetailClassName,
}: {
    readonly choice: ComputerChoice;
    readonly className?: string;
}) {
    const directory = choice.directoryName;
    const directoryTitle = choice.directory ?? undefined;
    if (choice.status === "online") {
        if (directory !== null) {
            return (
                <span className={className} title={directoryTitle}>
                    {directory}
                </span>
            );
        }
        if (choice.lastUsedAt > 0) {
            return <span className={className}>{`Last opened ${openedDate.format(new Date(choice.lastUsedAt))}`}</span>;
        }
        return null;
    }
    const statusLabel = choice.status === "offline" ? "Offline" : "Unavailable";
    if (directory === null) {
        return <span className={className}>{statusLabel}</span>;
    }
    return (
        <span className={className}>
            {statusLabel}
            {" · "}
            <span title={directoryTitle}>{directory}</span>
        </span>
    );
}

const computerChoiceRowClassName = "grid grid-cols-[1rem_minmax(0,1fr)_1rem] items-center outline-none";

const computerListChoiceInteractiveClassName =
    "hover:bg-morty-fill-opacity-2 active:bg-morty-fill-opacity-3 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/60";

const computerListChoiceClassName = cn(
    "gap-x-4 py-2.5 pr-4 pl-6 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
    computerListChoiceInteractiveClassName,
);

const computerListCurrentChoiceShellClassName = "outline-none";

const computerListChoiceLinkClassName =
    "gap-x-4 py-2.5 pr-4 pl-6 hover:bg-transparent active:bg-transparent focus-visible:ring-0";

const computerListDetailsTextButtonClassName =
    "inline-flex items-center gap-1 rounded-md text-[13px] font-medium text-copy-secondary outline-none transition-colors hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 motion-reduce:transition-none";

function ComputerListDetailsButton({
    computerName,
    onOpenDetails,
}: {
    readonly computerName: string;
    readonly onOpenDetails: () => void;
}) {
    return (
        <div className="pb-2.5 pl-12 pr-4 pt-1">
            <button
                aria-label={`View execution details for ${computerName}`}
                className={computerListDetailsTextButtonClassName}
                onClick={onOpenDetails}
                type="button"
            >
                View execution details
                <ChevronRight aria-hidden="true" className="size-3 shrink-0" />
            </button>
        </div>
    );
}

function ComputerChoiceContent({
    choice,
    current,
    detailClassName,
    titleClassName = "text-14",
}: {
    readonly choice: ComputerChoice;
    readonly current: boolean;
    readonly detailClassName?: string;
    readonly titleClassName?: string;
}) {
    return (
        <>
            <span className="flex h-[22px] w-4 shrink-0 self-start items-center justify-center">
                <span
                    aria-hidden="true"
                    className={cn(
                        "rounded-full",
                        choice.status === "online" ? "size-2 bg-emerald-500" : "size-2 bg-muted-foreground/60",
                    )}
                />
                {choice.status === "online" ? <span className="sr-only">Online</span> : null}
            </span>
            <span className="flex min-w-0 flex-col gap-1">
                <span className={cn("block truncate font-medium", titleClassName)} title={choice.name}>
                    {choice.name}
                </span>
                {detailClassName === undefined ? (
                    <ComputerChoiceDetail choice={choice} />
                ) : (
                    <ComputerChoiceDetail choice={choice} className={detailClassName} />
                )}
            </span>
            <span className="flex size-4 items-center justify-center" aria-hidden="true">
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
                    "gap-x-2 rounded-md px-3 py-2",
                    current
                        ? "cursor-default data-[highlighted]:bg-transparent data-[highlighted]:shadow-none data-[highlighted]:outline-none"
                        : "transition-colors hover:bg-morty-fill-opacity-2 active:bg-morty-fill-opacity-3 data-[highlighted]:bg-accent motion-reduce:transition-none",
                )}
                aria-current={current ? "true" : undefined}
                data-current-computer={current ? "true" : undefined}
            >
                <ComputerChoiceContent choice={choice} current={current} />
            </a>
        </DropdownMenu.Item>
    );
}

function ComputerChoiceList({
    activeKey,
    choices,
    computerName,
    loading,
    openDetails,
}: {
    readonly activeKey: string;
    readonly choices: readonly ComputerChoice[];
    readonly computerName: string;
    readonly loading: boolean;
    readonly openDetails: () => void;
}) {
    const sections = computerSections(choices, activeKey);
    return (
        <>
            <DropdownMenu.Label className={computerMenuLabelClassName}>Current</DropdownMenu.Label>
            <DropdownMenu.Group aria-label="Current computer" className="rounded-lg pb-1">
                {sections.current === null ? (
                    <p className="px-3 py-2 text-copy-tertiary" role={loading ? "status" : undefined}>
                        {loading ? "Checking connections…" : computerName}
                    </p>
                ) : (
                    <ComputerChoiceItem activeKey={activeKey} choice={sections.current} />
                )}
                <div className="-mt-1 pb-1 pl-9 pr-3">
                    <DropdownMenu.Item
                        aria-label={`View execution details for ${computerName}`}
                        className="-mx-3 inline-flex h-8 w-fit cursor-pointer items-center gap-1 rounded-md px-3 text-xs font-medium text-copy-secondary outline-none data-[highlighted]:bg-morty-fill-opacity-2 data-[highlighted]:text-foreground"
                        onSelect={openDetails}
                    >
                        View execution details
                        <ChevronRight aria-hidden="true" className="size-3 shrink-0" />
                    </DropdownMenu.Item>
                </div>
            </DropdownMenu.Group>
            {sections.others.length > 0 ? (
                <DropdownMenu.Group aria-label="Other computers" className="mt-2">
                    <DropdownMenu.Label className={computerMenuLabelClassName}>Other computers</DropdownMenu.Label>
                    {sections.others.map((choice) => (
                        <ComputerChoiceItem activeKey={activeKey} choice={choice} key={choice.key} />
                    ))}
                </DropdownMenu.Group>
            ) : null}
        </>
    );
}

const sidebarNavOptionTriggerClassName =
    "flex w-full items-center gap-2.5 rounded-lg px-[10px] py-2 text-left text-[13px] font-medium text-copy-secondary outline-none transition-[background-color,color] duration-150 hover:bg-morty-fill-opacity-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 active:bg-morty-fill-opacity-3 active:text-foreground motion-reduce:transition-none";

export const mobileDrawerCardClassName = "flex flex-col overflow-hidden rounded-lg bg-morty-fill-white text-foreground";

export const mobileDrawerOptionDividerClassName = "[&>*+*]:border-t-[0.5px] [&>*+*]:border-black/[0.06]";

export const mobileDrawerCardRowClassName =
    "flex h-12 w-full items-center gap-3 px-4 text-left text-[15px] font-medium text-foreground outline-none transition-colors hover:bg-morty-fill-opacity-2 active:bg-morty-fill-opacity-3 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

const mobileComputersSectionTitleClassName =
    "px-4 pt-3 pb-1 text-[15px] font-semibold leading-5 tracking-[-0.015em] text-foreground";

const mobileComputersSectionLabelClassName = "px-4 pt-1 pb-1 text-xs font-normal text-morty-text-3";

const mobileComputersOtherSectionLabelClassName = "px-4 pt-3 pb-1 text-xs font-normal text-morty-text-3";

function ComputerListChoice({
    activeKey,
    choice,
    computerNameForDetails,
    openDetails,
}: {
    readonly activeKey: string;
    readonly choice: ComputerChoice;
    readonly computerNameForDetails?: string;
    readonly openDetails?: () => void;
}) {
    const current = choice.key === activeKey;
    const showDetails = current && openDetails !== undefined;
    if (!showDetails) {
        return (
            <a
                href={choice.href}
                aria-current={current ? "true" : undefined}
                className={cn(computerChoiceRowClassName, computerListChoiceClassName)}
            >
                <ComputerChoiceContent
                    choice={choice}
                    current={current}
                    detailClassName={computerListChoiceDetailClassName}
                    titleClassName="text-[15px]"
                />
            </a>
        );
    }
    const detailsName = computerNameForDetails ?? choice.name;
    return (
        <div className={computerListCurrentChoiceShellClassName}>
            <a
                href={choice.href}
                aria-current="true"
                className={cn(computerChoiceRowClassName, computerListChoiceLinkClassName, "pb-0")}
            >
                <ComputerChoiceContent
                    choice={choice}
                    current={current}
                    detailClassName={computerListChoiceDetailClassName}
                    titleClassName="text-[15px]"
                />
            </a>
            <ComputerListDetailsButton computerName={detailsName} onOpenDetails={openDetails} />
        </div>
    );
}

function ComputerListChoices({
    activeKey,
    choices,
    computerName,
    openDetails,
    status,
}: {
    readonly activeKey: string;
    readonly choices: readonly ComputerChoice[];
    readonly computerName: string;
    readonly openDetails: () => void;
    readonly status: BotConnectionStatus;
}) {
    const sections = computerSections(choices, activeKey);
    return (
        <>
            <section aria-label="Current computer">
                <p className={mobileComputersSectionLabelClassName}>Current</p>
                {sections.current === null ? (
                    <div className={computerListCurrentChoiceShellClassName}>
                        <span className={cn(computerChoiceRowClassName, computerListChoiceLinkClassName, "pb-0")}>
                            <span className="flex h-[22px] w-4 shrink-0 self-start items-center justify-center">
                                <span
                                    aria-hidden="true"
                                    className={cn(
                                        "rounded-full",
                                        status.kind === "connected"
                                            ? "size-2 bg-emerald-500"
                                            : "size-2 bg-muted-foreground/60",
                                    )}
                                />
                            </span>
                            <span className="flex min-w-0 flex-col gap-1">
                                <span className="block truncate text-[15px] font-medium" title={computerName}>
                                    {computerName}
                                </span>
                                {status.kind === "connected" ? null : (
                                    <span className={computerListChoiceDetailClassName}>
                                        {status.kind === "connecting" ? "Connecting" : "Offline"}
                                    </span>
                                )}
                            </span>
                            <span className="flex size-4 items-center justify-center" aria-hidden="true">
                                <Check className="size-3.5" />
                            </span>
                        </span>
                        <ComputerListDetailsButton computerName={computerName} onOpenDetails={openDetails} />
                    </div>
                ) : (
                    <ComputerListChoice
                        activeKey={activeKey}
                        choice={sections.current}
                        computerNameForDetails={computerName}
                        openDetails={openDetails}
                    />
                )}
            </section>
            {sections.others.length > 0 ? (
                <section aria-label="Other computers">
                    <p className={mobileComputersOtherSectionLabelClassName}>Other computers</p>
                    <div className={mobileDrawerOptionDividerClassName}>
                        {sections.others.map((choice) => (
                            <ComputerListChoice activeKey={activeKey} choice={choice} key={choice.key} />
                        ))}
                    </div>
                </section>
            ) : null}
        </>
    );
}

export function ComputerSwitcher({
    context,
    model,
    name,
    status,
    layout = "block",
}: {
    readonly context: ExecutionContext;
    readonly model: ComputerSwitcherModel;
    readonly name: string;
    readonly status: BotConnectionStatus;
    readonly layout?: "block" | "header" | "list";
}) {
    const state = useStore(model.store);
    const choices = state.choices;
    const activeKey = model.activeKey;
    const listLoading = state.kind === "loading";
    const active = choices.find((choice) => choice.key === activeKey);
    const computerName = name || active?.name || "Computer";
    if (layout === "list") {
        return (
            <ComputerExecutionDetails context={context}>
                {({ openDetails }) => (
                    <nav aria-label="Computers" className="flex w-full min-w-0 flex-col">
                        <p className={mobileComputersSectionTitleClassName}>Computers</p>
                        <div className="flex w-full min-w-0 flex-col">
                            <ComputerListChoices
                                activeKey={activeKey}
                                choices={choices}
                                computerName={computerName}
                                openDetails={openDetails}
                                status={status}
                            />
                            <a
                                href="/setup"
                                className={cn(
                                    mobileDrawerCardRowClassName,
                                    "mt-2 border-t-[0.5px] border-black/[0.06]",
                                )}
                            >
                                <Plus aria-hidden="true" className="size-5 shrink-0 text-copy-secondary" />
                                Connect another computer
                            </a>
                        </div>
                    </nav>
                )}
            </ComputerExecutionDetails>
        );
    }
    const inHeader = layout === "header";
    return (
        <ComputerExecutionDetails context={context}>
            {({ open: detailsOpen, openDetails }) => (
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
                            aria-describedby="computer-connection-description"
                            aria-label={`Switch computer, ${computerName}`}
                            data-connection-status={status.kind}
                            data-testid={dataTestId.botConnectionStatus}
                            className={
                                inHeader
                                    ? "flex max-w-[120px] min-w-0 items-center gap-0.5 overflow-hidden rounded-lg px-3 py-1.5 text-left text-12 outline-none hover:bg-muted data-[state=open]:bg-muted data-[state=open]:shadow-none data-[state=open]:outline-none max-sm:min-h-11"
                                    : sidebarNavOptionTriggerClassName
                            }
                        >
                            {inHeader ? (
                                <>
                                    <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-1.5">
                                        <BotConnectionStatusIndicator status={status} />
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
                                    <BotConnectionStatusIndicator status={status} />
                                    <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-copy-secondary" />
                                </>
                            )}
                        </button>
                    </DropdownMenu.Trigger>
                    <span className="sr-only" id="computer-connection-description">
                        {context.indicator.label}
                    </span>
                    <DropdownMenu.Portal>
                        <DropdownMenu.Content
                            align="start"
                            sideOffset={overlayTriggerOffsetPx}
                            onCloseAutoFocus={(event) => {
                                if (detailsOpen) {
                                    event.preventDefault();
                                }
                            }}
                            {...({
                                onOpenAutoFocus: preventOverlayOpenAutoFocus,
                            } satisfies OverlayContentOpenAutoFocus)}
                            className={cn(
                                "z-[180] flex max-h-[min(70dvh,520px)] w-[min(calc(100vw-1.5rem),320px)] animate-cloud-enter flex-col overflow-hidden p-1.5 text-sm text-foreground outline-none motion-reduce:animate-none",
                                overlaySurfacePanelClassName,
                                overlaySurfaceRadiusClassName,
                            )}
                            aria-label="Computers"
                        >
                            <DropdownMenu.Label className="flex shrink-0 items-center justify-between gap-2 px-3 pt-1 pb-3 text-16 font-semibold text-copy-tertiary">
                                Computers
                                {listLoading ? (
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
                                <ComputerChoiceList
                                    activeKey={activeKey}
                                    choices={choices}
                                    computerName={computerName}
                                    loading={listLoading}
                                    openDetails={openDetails}
                                />
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
            )}
        </ComputerExecutionDetails>
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
