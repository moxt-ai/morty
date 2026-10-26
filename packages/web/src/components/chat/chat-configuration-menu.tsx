import { ChevronDown } from "lucide-react";
import { Tooltip } from "radix-ui";
import { useRef, useState } from "react";
import { dataTestId } from "@/data-testid";
import { cn } from "@/lib/utils";
import { MortyTooltipContent } from "../ui/morty-tooltip-content.tsx";
import { Select } from "../ui/option-select.tsx";
import {
    overlaySurfacePanelClassName,
    overlaySurfaceRadiusClassName,
    overlayTriggerOffsetPx,
} from "../ui/overlay-surface.ts";
import { Popover } from "../ui/popover.tsx";
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
                className="grid min-w-0 grid-cols-2 gap-1.5"
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
                            className={cn(
                                "flex h-9 w-full min-w-0 items-center justify-center gap-2 rounded-lg border px-3 text-center text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none disabled:cursor-not-allowed",
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
                            <span className="min-w-0 truncate">{label}</span>
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
                <div aria-hidden="true" className="flex flex-col gap-1.5" key={row.key}>
                    <span
                        className={cn(
                            "mx-1 h-3 animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none",
                            row.label,
                        )}
                    />
                    <div className="flex h-9 items-center rounded-lg border border-border bg-background px-3">
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

function SettingControl({
    control,
    mutedWhenDisabled = true,
    valueLoading,
}: {
    readonly control: ChatConfigurationControl;
    readonly mutedWhenDisabled?: boolean;
    readonly valueLoading: boolean;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <span className="px-1 text-xs font-medium text-copy-tertiary">{control.label}</span>
            {control.kind === "select" ? (
                <Select
                    disabled={control.disabled || valueLoading}
                    label={control.label}
                    mutedWhenDisabled={mutedWhenDisabled}
                    onValueChange={control.onValueChange}
                    options={control.options}
                    searchable={control.searchable}
                    testId={control.testId}
                    value={control.value}
                    valueLoading={valueLoading}
                />
            ) : valueLoading ? (
                <div
                    aria-busy="true"
                    className="flex h-11 items-center justify-between rounded-xl border border-border bg-surface-subtle px-3"
                    data-testid={control.testId}
                    role="status"
                >
                    <span
                        aria-hidden="true"
                        className="h-3.5 w-8 animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none"
                    />
                    <span
                        aria-hidden="true"
                        className="h-6 w-10 animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none"
                    />
                </div>
            ) : (
                <button
                    aria-checked={control.checked}
                    className={cn(
                        "flex h-11 items-center justify-between rounded-xl border border-border bg-surface-subtle px-3 text-sm disabled:cursor-not-allowed",
                        mutedWhenDisabled && "disabled:opacity-50",
                    )}
                    data-testid={control.testId}
                    disabled={control.disabled}
                    onClick={control.onCheckedChange}
                    role="switch"
                    type="button"
                >
                    <span>{control.checked ? "On" : "Off"}</span>
                    <span
                        aria-hidden="true"
                        className={`flex h-6 w-10 items-center rounded-full p-0.5 transition-colors ${control.checked ? "bg-primary" : "bg-muted"}`}
                    >
                        <span
                            className={`size-5 rounded-full bg-white shadow-sm transition-transform ${control.checked ? "translate-x-4" : "translate-x-0"}`}
                        />
                    </span>
                </button>
            )}
        </div>
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
    return (
        <Popover.Root onOpenChange={setOpen} open={open}>
            <Popover.Trigger asChild>
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
                    <span className="min-w-0 truncate">
                        {selections.filter((value) => value.length > 0).join(" · ")}
                    </span>
                    <ChevronDown
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-muted-foreground transition-colors duration-150 group-hover:text-foreground group-active:text-foreground group-data-[state=open]:text-foreground motion-reduce:transition-none"
                    />
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    align="start"
                    aria-label="Agent configuration"
                    className={cn(
                        "z-50 flex h-[min(70dvh,var(--radix-popover-content-available-height,70dvh))] max-h-[min(70dvh,var(--radix-popover-content-available-height,70dvh))] w-[min(calc(100vw-1.5rem),400px)] min-h-0 flex-col overflow-hidden",
                        overlaySurfacePanelClassName,
                        overlaySurfaceRadiusClassName,
                    )}
                    role="dialog"
                    side="top"
                    sideOffset={overlayTriggerOffsetPx}
                >
                    {harness !== undefined && selectedHarness !== undefined && harness.locked === true && (
                        <div className="px-4 pt-4">
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
                    <div
                        aria-busy={settingsLoading}
                        className={cn(
                            "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 pt-4 pb-4",
                            mortyThinScrollbarClassName,
                        )}
                        {...(settingsLoading
                            ? { "data-testid": dataTestId.agentSettingsLoading, role: "status" as const }
                            : {})}
                    >
                        {settingsLoading && <span className="sr-only">Loading harness settings…</span>}
                        {harness !== undefined && selectedHarness !== undefined && harness.locked !== true && (
                            <HarnessSelect harness={harness} mutedWhenDisabled={!settingsLoading} />
                        )}
                        <div className="flex min-w-0 flex-col gap-3">
                            {settingsLoading && displayedSettings.length === 0 ? (
                                <SettingsDataSkeleton />
                            ) : displayedSettings.length === 0 ? (
                                <p className="text-center text-xs text-muted-foreground">
                                    This harness has no configurable settings.
                                </p>
                            ) : (
                                displayedSettings.map((control) => (
                                    <SettingControl
                                        control={control}
                                        key={control.id}
                                        mutedWhenDisabled={loadingControlId === undefined}
                                        valueLoading={settingsLoading || control.id === loadingControlId}
                                    />
                                ))
                            )}
                        </div>
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
