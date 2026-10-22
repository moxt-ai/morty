import { ChevronDown, LoaderCircle } from "lucide-react";
import { Tooltip } from "radix-ui";
import { useState } from "react";
import { dataTestId } from "@/data-testid";
import { cn } from "@/lib/utils";
import { MortyTooltipContent } from "../ui/morty-tooltip-content.tsx";
import { Select } from "../ui/option-select.tsx";
import { overlaySurfacePanelClassName, overlaySurfaceRadiusClassName } from "../ui/overlay-surface.ts";
import { Popover } from "../ui/popover.tsx";
import { useAgentConfigPreviewState } from "./chat-configuration-menu-preview.ts";
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

const configurationHarnessTabClassName =
    "group relative flex w-10 min-w-0 shrink-0 grow-0 items-center justify-center gap-1.5 rounded-full px-1.5 text-[13px] text-copy-secondary outline-none transition-[flex-grow,background-color,color,box-shadow] duration-200 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent aria-[selected=false]:opacity-60 aria-[selected=false]:hover:bg-morty-fill-opacity-3 aria-[selected=true]:grow aria-[selected=true]:shrink aria-[selected=true]:bg-background aria-[selected=true]:px-2.5 aria-[selected=true]:font-medium aria-[selected=true]:text-foreground aria-[selected=true]:shadow-sm motion-reduce:transition-none";

export function ChatConfigurationMenu({
    controls,
    settingsLoading = false,
}: {
    readonly controls: readonly ChatConfigurationControl[];
    readonly settingsLoading?: boolean;
}) {
    // TEMP style-tuning preview: `?agentConfigPreview=menu-open|menu-model-open|menu-loading`. Remove with chat-configuration-menu-preview.ts.
    const previewState = useAgentConfigPreviewState();
    const forceMenuOpen = previewState !== null;
    const [open, setOpen] = useState(false);
    const harness = controls.find(
        (control): control is ChatConfigurationSelectControl => control.id === "harness" && control.kind === "select",
    );
    const settings = controls.filter((control) => control !== harness);
    const selectedHarness = harness?.options.find((option) => option.value === harness.value);
    const selections = settings.map((control) =>
        control.kind === "boolean"
            ? `${control.label}: ${control.checked ? "On" : "Off"}`
            : (control.options.find((option) => option.value === control.value)?.label ?? control.value),
    );
    const effectiveSettingsLoading = previewState === "menu-loading" ? true : settingsLoading;
    return (
        <Popover.Root
            onOpenChange={(nextOpen) => {
                if (forceMenuOpen) {
                    return;
                }
                setOpen(nextOpen);
            }}
            open={forceMenuOpen ? true : open}
        >
            <Popover.Trigger asChild>
                <button
                    aria-label="Configure agent"
                    className="group flex h-9 min-w-0 max-w-[200px] items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-copy-secondary outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground active:bg-accent-active active:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-accent-active data-[state=open]:text-foreground motion-reduce:transition-none"
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
                        "z-50 flex w-[min(calc(100vw-1.5rem),400px)] flex-col overflow-hidden",
                        overlaySurfacePanelClassName,
                        overlaySurfaceRadiusClassName,
                    )}
                    role="dialog"
                    side="top"
                    sideOffset={10}
                >
                    {harness !== undefined && selectedHarness !== undefined && (
                        <div className="px-4 pt-4">
                            {harness.locked === true ? (
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
                                            <MortyTooltipContent
                                                className="max-w-60 leading-5"
                                                side="top"
                                                sideOffset={6}
                                            >
                                                {harness.harnessLockedLabel ?? selectedHarness.label}
                                                <Tooltip.Arrow className="fill-foreground" />
                                            </MortyTooltipContent>
                                        </Tooltip.Portal>
                                    </Tooltip.Root>
                                </Tooltip.Provider>
                            ) : (
                                <div
                                    aria-label="Harness"
                                    className="flex h-9 min-w-0 gap-0.5 rounded-full bg-morty-fill-opacity-2 p-0.5"
                                    role="tablist"
                                >
                                    {harness.options.map((option) => {
                                        const installed = option.installed !== false;
                                        return (
                                            <button
                                                aria-selected={option.value === harness.value}
                                                className={cn(
                                                    configurationHarnessTabClassName,
                                                    !installed &&
                                                        "aria-[selected=false]:opacity-45 disabled:opacity-45",
                                                )}
                                                data-installed={installed ? "true" : "false"}
                                                data-testid={dataTestId.agentHarness(option.value)}
                                                disabled={harness.disabled || !installed}
                                                key={option.value}
                                                onClick={() => {
                                                    if (option.value !== harness.value) {
                                                        harness.onValueChange(option.value);
                                                    }
                                                }}
                                                role="tab"
                                                title={installed ? option.label : `${option.label} (not installed)`}
                                                type="button"
                                            >
                                                <HarnessMark
                                                    agentRef={option.agentRef ?? option.value}
                                                    appearance="line"
                                                    label={option.label}
                                                    testId={dataTestId.harnessMark}
                                                />
                                                <span
                                                    className={cn(
                                                        "min-w-0 truncate",
                                                        option.value !== harness.value && "sr-only",
                                                    )}
                                                >
                                                    {option.tabLabel ?? option.label}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}
                    <div
                        aria-busy={effectiveSettingsLoading}
                        className="flex min-h-44 flex-col gap-3 p-4"
                        role="tabpanel"
                    >
                        {effectiveSettingsLoading ? (
                            <div
                                className="flex min-h-36 flex-1 items-center justify-center"
                                data-testid={dataTestId.agentSettingsLoading}
                                role="status"
                            >
                                <LoaderCircle
                                    aria-hidden="true"
                                    className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none"
                                />
                                <span className="sr-only">Loading harness settings…</span>
                            </div>
                        ) : settings.length === 0 ? (
                            <p className="text-center text-xs text-muted-foreground">
                                This harness has no configurable settings.
                            </p>
                        ) : (
                            settings.map((control) => (
                                <div className="flex flex-col gap-1.5" key={control.id}>
                                    <span className="px-1 text-xs font-medium text-copy-tertiary">{control.label}</span>
                                    {control.kind === "select" ? (
                                        <Select
                                            disabled={control.disabled}
                                            label={control.label}
                                            onValueChange={control.onValueChange}
                                            options={control.options}
                                            previewOpen={previewState === "menu-model-open" && control.id === "model"}
                                            searchable={control.searchable}
                                            testId={control.testId}
                                            value={control.value}
                                        />
                                    ) : (
                                        <button
                                            aria-checked={control.checked}
                                            className="flex h-11 items-center justify-between rounded-xl border border-border bg-surface-subtle px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
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
                            ))
                        )}
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
