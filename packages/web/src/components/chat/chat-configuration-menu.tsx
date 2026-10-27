import { ArrowLeft, Check, ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { Dialog, Tooltip } from "radix-ui";
import { useEffect, useId, useRef, useState } from "react";
import { dataTestId } from "@/data-testid";
import { cn } from "@/lib/utils";
import { MortyTooltipContent } from "../ui/morty-tooltip-content.tsx";
import {
    overlaySurfacePanelClassName,
    overlaySurfaceRadiusClassName,
    overlayTriggerOffsetPx,
} from "../ui/overlay-surface.ts";
import { Popover } from "../ui/popover.tsx";
import { ScrollEdgeFade } from "../utils/scroll-edge-fade.tsx";
import { useConfigurationViewport } from "./chat-configuration-viewport.ts";
import { mortyThinScrollbarClassName } from "./chat-session-layout.ts";
import { HarnessMark } from "./harness-mark.tsx";

interface ChatConfigurationSelectControl {
    readonly disabled: boolean;
    readonly harnessLockedLabel?: string | undefined;
    readonly id: string;
    readonly kind: "select";
    readonly label: string;
    readonly locked?: boolean | undefined;
    readonly onValueChange: (value: string) => void;
    readonly options: readonly {
        readonly agentRef?: string;
        readonly installed?: boolean;
        readonly label: string;
        readonly tabLabel?: string;
        readonly value: string;
    }[];
    readonly searchable?: boolean;
    readonly testId?: string | undefined;
    readonly value: string;
}

interface ChatConfigurationBooleanControl {
    readonly checked: boolean;
    readonly disabled: boolean;
    readonly id: string;
    readonly kind: "boolean";
    readonly label: string;
    readonly onCheckedChange: () => void;
    readonly testId?: string | undefined;
}

export type ChatConfigurationControl = ChatConfigurationSelectControl | ChatConfigurationBooleanControl;

function HarnessSelect({
    harness,
    mutedWhenDisabled = true,
}: {
    readonly harness: ChatConfigurationSelectControl;
    readonly mutedWhenDisabled?: boolean;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <span className="px-1 text-xs font-medium text-copy-tertiary">{harness.label}</span>
            <div
                aria-label={harness.label}
                className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(88px,1fr))] gap-1.5"
                data-testid={dataTestId.agentSetting("harness")}
                role="radiogroup"
            >
                {harness.options.map((option) => {
                    const installed = option.installed !== false;
                    const label = option.tabLabel ?? option.label;
                    const selected = option.value === harness.value;
                    return (
                        // biome-ignore lint/a11y/useSemanticElements: harness cards use button styling inside a radiogroup.
                        <button
                            aria-checked={selected}
                            aria-disabled={!installed || harness.disabled}
                            aria-description={installed ? undefined : "Not installed"}
                            className={cn(
                                "flex min-h-11 w-full min-w-0 flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2 text-center text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none disabled:cursor-not-allowed",
                                selected
                                    ? "border-foreground bg-foreground font-medium text-background hover:border-foreground hover:bg-foreground hover:text-background"
                                    : "border-border bg-background text-foreground hover:border-foreground/20 hover:bg-accent",
                                mutedWhenDisabled &&
                                    "disabled:cursor-not-allowed disabled:border-border disabled:bg-background disabled:text-copy-tertiary disabled:opacity-100 disabled:hover:border-border disabled:hover:bg-background",
                            )}
                            data-testid={dataTestId.sessionConfigValue(option.value)}
                            disabled={harness.disabled || !installed}
                            key={option.value}
                            onClick={() => {
                                if (!selected) {
                                    harness.onValueChange(option.value);
                                }
                            }}
                            role="radio"
                            title={installed ? label : `${label} (not installed)`}
                            type="button"
                        >
                            <HarnessMark
                                agentRef={option.agentRef ?? option.value}
                                appearance="line"
                                label={option.label}
                                testId={dataTestId.harnessMark}
                            />
                            <span className="min-w-0 break-words">{label}</span>
                            {!installed && (
                                <span aria-hidden="true" className="text-[10px] font-normal">
                                    Not installed
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

const SETTINGS_DATA_SKELETON_ROWS = [
    { key: "model", label: "w-12", value: "w-28" },
    { key: "reasoning", label: "w-28", value: "w-16" },
    { key: "mode", label: "w-14", value: "w-20" },
    { key: "access", label: "w-24", value: "w-24" },
] as const;

function SettingsDataSkeleton() {
    return (
        <>
            {SETTINGS_DATA_SKELETON_ROWS.map((row) => (
                <div aria-hidden="true" className="flex min-h-14 items-center justify-between gap-4 px-2" key={row.key}>
                    <span
                        className={cn(
                            "mx-1 h-3 animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none",
                            row.label,
                        )}
                    />
                    <div className="flex items-center">
                        <span
                            className={cn(
                                "h-3.5 animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none",
                                row.value,
                            )}
                        />
                    </div>
                </div>
            ))}
        </>
    );
}

type ConfigurationPage = { readonly kind: "overview" } | { readonly kind: "picker"; readonly controlId: string };

function SettingPicker({
    control,
    onSelect,
    id,
}: {
    readonly control: ChatConfigurationSelectControl;
    readonly onSelect: (value: string) => void;
    readonly id: string;
}) {
    const [search, setSearch] = useState("");
    const listRef = useRef<HTMLDivElement | null>(null);
    const query = search.trim().toLocaleLowerCase();
    const options = control.options.filter((option) =>
        [option.label, option.value].some((value) => value.toLocaleLowerCase().includes(query)),
    );
    const selected = options.find((option) => option.value === control.value) ?? options[0];
    const focusOption = (direction: "first" | "last" | "next" | "previous") => {
        const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
        const current =
            document.activeElement instanceof HTMLButtonElement ? buttons.indexOf(document.activeElement) : -1;
        const index =
            direction === "first"
                ? 0
                : direction === "last"
                  ? buttons.length - 1
                  : direction === "next"
                    ? (current + 1) % buttons.length
                    : (current - 1 + buttons.length) % buttons.length;
        buttons[index]?.focus();
    };
    return (
        <div className={cn("flex min-h-0 flex-col", control.searchable && "h-80")}>
            {control.searchable && (
                <div className="relative mx-4 mb-2 shrink-0">
                    <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-copy-tertiary"
                    />
                    <input
                        aria-label="Search models"
                        autoComplete="off"
                        className="h-11 w-full rounded-lg border border-border bg-background pr-3 pl-9 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        data-testid={dataTestId.modelSearch}
                        onChange={(event) => setSearch(event.currentTarget.value)}
                        onKeyDown={(event) => {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                focusOption("first");
                            }
                        }}
                        placeholder="Search models…"
                        type="search"
                        value={search}
                    />
                </div>
            )}
            <div
                aria-label={control.label}
                id={id}
                className={cn(
                    "min-h-0 flex-auto overflow-y-auto overscroll-contain px-2 pb-[max(1rem,env(safe-area-inset-bottom))]",
                    mortyThinScrollbarClassName,
                )}
                onKeyDown={(event) => {
                    const direction =
                        event.key === "ArrowDown"
                            ? "next"
                            : event.key === "ArrowUp"
                              ? "previous"
                              : event.key === "Home"
                                ? "first"
                                : event.key === "End"
                                  ? "last"
                                  : undefined;
                    if (direction !== undefined) {
                        event.preventDefault();
                        focusOption(direction);
                    }
                }}
                ref={listRef}
                role="listbox"
                tabIndex={-1}
            >
                {options.map((option) => (
                    <button
                        aria-selected={option.value === control.value}
                        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 aria-selected:bg-accent"
                        data-testid={dataTestId.sessionConfigValue(option.value)}
                        key={option.value}
                        onClick={() => onSelect(option.value)}
                        role="option"
                        tabIndex={option.value === selected?.value ? 0 : -1}
                        type="button"
                    >
                        <span className="min-w-0 break-words">{option.label}</span>
                        {option.value === control.value && <Check aria-hidden="true" className="size-4 shrink-0" />}
                    </button>
                ))}
                {options.length === 0 && (
                    <p className="px-3 py-6 text-sm text-copy-tertiary" role="status">
                        No models found.
                    </p>
                )}
            </div>
        </div>
    );
}

function SettingControl({
    control,
    mutedWhenDisabled = true,
    valueLoading,
    onOpen,
    assignButton,
    pickerId,
}: {
    readonly control: ChatConfigurationControl;
    readonly mutedWhenDisabled?: boolean;
    readonly valueLoading: boolean;
    readonly onOpen: () => void;
    readonly assignButton: (node: HTMLButtonElement | null) => void;
    readonly pickerId: string;
}) {
    const value =
        control.kind === "select"
            ? (control.options.find((option) => option.value === control.value)?.label ?? control.value)
            : control.checked
              ? "On"
              : "Off";
    return (
        <button
            aria-busy={valueLoading || undefined}
            {...(control.kind === "select"
                ? { role: "combobox", "aria-controls": pickerId, "aria-expanded": false, "aria-haspopup": "listbox" }
                : { role: "switch", "aria-checked": control.checked })}
            aria-label={control.label}
            className={cn(
                "flex min-h-14 w-full items-center justify-between gap-4 rounded-lg px-2 py-3 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed",
                mutedWhenDisabled && "disabled:opacity-50",
            )}
            data-testid={control.testId}
            disabled={control.disabled || valueLoading}
            onClick={control.kind === "select" ? onOpen : control.onCheckedChange}
            ref={assignButton}
            type="button"
        >
            <span className="shrink-0 text-copy-secondary">{control.label}</span>
            <span className="flex min-w-0 items-center justify-end gap-2 text-right">
                {valueLoading ? (
                    <span
                        aria-label={`Loading ${control.label}`}
                        className="h-3.5 w-20 animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none"
                        role="status"
                    />
                ) : (
                    <span className="min-w-0 break-words">{value}</span>
                )}
                {control.kind === "select" ? (
                    <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-copy-tertiary" />
                ) : (
                    <span
                        aria-hidden="true"
                        className={cn(
                            "flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors",
                            control.checked ? "bg-primary" : "bg-muted",
                        )}
                    >
                        <span
                            className={cn(
                                "size-5 rounded-full bg-white shadow-sm transition-transform",
                                control.checked ? "translate-x-4" : "translate-x-0",
                            )}
                        />
                    </span>
                )}
            </span>
        </button>
    );
}

export function ChatConfigurationMenu({
    controls,
    loadingControlId,
    settingsLoading = false,
}: {
    readonly controls: readonly ChatConfigurationControl[];
    /** One setting's value is being written back. Other fields stay as they are. */
    readonly loadingControlId?: string;
    readonly settingsLoading?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const retainedSettingsRef = useRef<readonly ChatConfigurationControl[]>([]);
    const viewport = useConfigurationViewport();
    const desktop = viewport.desktop;
    const [page, setPage] = useState<ConfigurationPage>({ kind: "overview" });
    const pickerId = useId();
    const buttonsRef = useRef(new Map<string, HTMLButtonElement>());
    const restoreFocusRef = useRef<string | null>(null);
    const backRef = useRef<HTMLButtonElement | null>(null);
    useEffect(() => {
        if (page.kind === "picker") {
            backRef.current?.focus();
            return;
        }
        const id = restoreFocusRef.current;
        const button = id === null ? undefined : buttonsRef.current.get(id);
        if (!settingsLoading && loadingControlId !== id && button !== undefined && !button.disabled) {
            button.focus();
            restoreFocusRef.current = null;
        }
    }, [page, loadingControlId, settingsLoading]);
    const changeOpen = (next: boolean) => {
        setOpen(next);
        if (!next) {
            setPage({ kind: "overview" });
            restoreFocusRef.current = null;
        }
    };
    const goBack = () => {
        if (page.kind === "picker") {
            restoreFocusRef.current = page.controlId;
            setPage({ kind: "overview" });
        }
    };
    const onEscapeKeyDown = (event: KeyboardEvent) => {
        if (page.kind === "picker") {
            event.preventDefault();
            goBack();
        }
    };
    const harness = controls.find(
        (control): control is ChatConfigurationSelectControl => control.id === "harness" && control.kind === "select",
    );
    const settings = controls.filter((control) => control !== harness);
    if (settings.length > 0) {
        retainedSettingsRef.current = settings;
    }
    // A harness switch clears options immediately. Keep the fields already on
    // screen until the next settings arrive, so the panel does not resize first.
    const displayedSettings = settingsLoading && settings.length === 0 ? retainedSettingsRef.current : settings;
    const selectedHarness = harness?.options.find((option) => option.value === harness.value);
    const selectionSource = displayedSettings.length > 0 ? displayedSettings : settings;
    const selections = selectionSource.map((control) =>
        control.kind === "boolean"
            ? `${control.label}: ${control.checked ? "On" : "Off"}`
            : (control.options.find((option) => option.value === control.value)?.label ?? control.value),
    );
    const trigger = (
        <button
            aria-label="Configure agent"
            className="group flex h-9 min-w-0 max-w-[200px] items-center gap-1.5 rounded-lg px-3 text-[13px] text-copy-secondary outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground active:bg-accent-active active:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-accent-active data-[state=open]:text-foreground motion-reduce:transition-none"
            data-testid={dataTestId.agentConfiguration}
            title={selections.join(" · ")}
            type="button"
        >
            {selectedHarness !== undefined && (
                <HarnessMark
                    agentRef={selectedHarness.agentRef ?? selectedHarness.value}
                    appearance="line"
                    label={selectedHarness.label}
                    testId={dataTestId.harnessTriggerMark}
                />
            )}
            <span className="min-w-0 truncate">{selections.filter((value) => value.length > 0).join(" · ")}</span>
            <ChevronDown
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground transition-colors duration-150 group-hover:text-foreground group-active:text-foreground group-data-[state=open]:text-foreground motion-reduce:transition-none"
            />
        </button>
    );
    const picker =
        page.kind === "picker"
            ? displayedSettings.find(
                  (control): control is ChatConfigurationSelectControl =>
                      control.id === page.controlId && control.kind === "select",
              )
            : undefined;
    const header = (
        <header className="flex min-h-14 shrink-0 items-center gap-2 px-3">
            {picker !== undefined && (
                <button
                    aria-label="Back to Agent configuration"
                    className="flex size-11 shrink-0 items-center justify-center rounded-lg outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={goBack}
                    ref={backRef}
                    type="button"
                >
                    <ArrowLeft aria-hidden="true" className="size-4" />
                </button>
            )}
            <span className="min-w-0 flex-1 px-1 text-base font-semibold">
                {picker?.label ?? "Agent configuration"}
            </span>
            <button
                aria-label="Close Agent configuration"
                className="flex size-11 shrink-0 items-center justify-center rounded-lg text-copy-secondary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() => changeOpen(false)}
                type="button"
            >
                <X aria-hidden="true" className="size-4" />
            </button>
        </header>
    );
    const panelContents =
        picker !== undefined ? (
            <div className="flex min-h-0 flex-auto flex-col">
                <SettingPicker
                    control={picker}
                    id={pickerId}
                    key={picker.id}
                    onSelect={(value) => {
                        if (value !== picker.value) {
                            picker.onValueChange(value);
                        }
                        goBack();
                    }}
                />
            </div>
        ) : (
            <>
                {harness !== undefined && selectedHarness !== undefined && harness.locked === true && (
                    <div className="px-4 pb-2">
                        <Tooltip.Provider delayDuration={150}>
                            <Tooltip.Root>
                                <Tooltip.Trigger asChild>
                                    <h3
                                        className="min-w-0 truncate pr-8 text-16 font-semibold"
                                        data-testid={dataTestId.agentHarness(selectedHarness.value)}
                                    >
                                        {selectedHarness.tabLabel ?? selectedHarness.label}
                                    </h3>
                                </Tooltip.Trigger>
                                <Tooltip.Portal>
                                    <MortyTooltipContent className="max-w-60 leading-5" side="top" sideOffset={6}>
                                        {harness.harnessLockedLabel ?? selectedHarness.label}
                                        <Tooltip.Arrow className="fill-foreground" />
                                    </MortyTooltipContent>
                                </Tooltip.Portal>
                            </Tooltip.Root>
                        </Tooltip.Provider>
                    </div>
                )}
                <ScrollEdgeFade
                    fadeFromClassName="from-background"
                    fadeToClassName="to-background/0"
                    frameClassName="flex min-h-0 flex-auto flex-col"
                    className={cn(
                        "flex min-h-0 flex-auto flex-col gap-2 overflow-y-auto overscroll-contain px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]",
                        mortyThinScrollbarClassName,
                    )}
                >
                    {settingsLoading && (
                        <span className="sr-only" data-testid={dataTestId.agentSettingsLoading} role="status">
                            Loading harness settings…
                        </span>
                    )}
                    {harness !== undefined && selectedHarness !== undefined && harness.locked !== true && (
                        <HarnessSelect harness={harness} mutedWhenDisabled={!settingsLoading} />
                    )}
                    <div className="flex min-w-0 flex-col">
                        {settingsLoading && displayedSettings.length === 0 ? (
                            <SettingsDataSkeleton />
                        ) : displayedSettings.length === 0 ? (
                            <p className="text-center text-xs text-muted-foreground">
                                This harness has no configurable settings.
                            </p>
                        ) : (
                            displayedSettings.map((control) => (
                                <div className="border-b border-border/60 last:border-0" key={control.id}>
                                    <SettingControl
                                        control={control}
                                        assignButton={(node) => {
                                            if (node === null) {
                                                buttonsRef.current.delete(control.id);
                                            } else {
                                                buttonsRef.current.set(control.id, node);
                                            }
                                        }}
                                        onOpen={() => setPage({ kind: "picker", controlId: control.id })}
                                        pickerId={pickerId}
                                        mutedWhenDisabled={loadingControlId === undefined}
                                        valueLoading={settingsLoading || control.id === loadingControlId}
                                    />
                                </div>
                            ))
                        )}
                    </div>
                </ScrollEdgeFade>
            </>
        );
    if (!desktop) {
        return (
            <Dialog.Root onOpenChange={changeOpen} open={open}>
                <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
                <Dialog.Portal>
                    <Dialog.Overlay className="fixed inset-0 z-[120] bg-black/30 motion-safe:animate-cloud-enter" />
                    <Dialog.Content
                        aria-label="Agent configuration"
                        onEscapeKeyDown={onEscapeKeyDown}
                        style={{
                            maxHeight: `min(calc(100dvh - 1rem), ${viewport.height}px)`,
                            bottom: viewport.bottom,
                        }}
                        className={cn(
                            "fixed inset-x-0 bottom-0 z-[121] flex h-auto min-h-0 flex-col overflow-hidden rounded-t-overlay outline-none",
                            overlaySurfacePanelClassName,
                        )}
                    >
                        <Dialog.Title className="sr-only">Agent configuration</Dialog.Title>
                        {header}
                        <Dialog.Description className="sr-only">
                            Configure the Agent used for this conversation.
                        </Dialog.Description>
                        {panelContents}
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        );
    }
    return (
        <Popover.Root onOpenChange={changeOpen} open={open}>
            <Popover.Trigger asChild>{trigger}</Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    align="start"
                    aria-label="Agent configuration"
                    className={cn(
                        "z-50 flex h-auto max-h-[min(calc(100dvh-2rem),var(--radix-popover-content-available-height))] w-[min(calc(100vw-2rem),360px)] min-h-0 flex-col overflow-hidden",
                        overlaySurfacePanelClassName,
                        overlaySurfaceRadiusClassName,
                    )}
                    collisionPadding={16}
                    onEscapeKeyDown={onEscapeKeyDown}
                    role="dialog"
                    side="top"
                    sideOffset={overlayTriggerOffsetPx}
                >
                    {header}
                    {panelContents}
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
