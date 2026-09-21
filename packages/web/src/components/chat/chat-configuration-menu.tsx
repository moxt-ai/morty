import { ChevronDown, LoaderCircle, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { dataTestId } from "@/data-testid";
import { Select } from "../ui/option-select.tsx";
import { Popover } from "../ui/popover.tsx";

interface ChatConfigurationSelectControl {
    readonly disabled: boolean;
    readonly id: string;
    readonly kind: "select";
    readonly label: string;
    readonly onValueChange: (value: string) => void;
    readonly options: readonly { readonly label: string; readonly tabLabel?: string; readonly value: string }[];
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

export function ChatConfigurationMenu({
    controls,
    settingsLoading = false,
}: {
    readonly controls: readonly ChatConfigurationControl[];
    readonly settingsLoading?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const harness = controls.find(
        (control): control is ChatConfigurationSelectControl => control.id === "harness" && control.kind === "select",
    );
    const settings = controls.filter((control) => control !== harness);
    const selections = controls.map((control) =>
        control.kind === "boolean"
            ? `${control.label}: ${control.checked ? "On" : "Off"}`
            : (control.options.find((option) => option.value === control.value)?.label ?? control.value),
    );
    return (
        <Popover.Root onOpenChange={setOpen} open={open}>
            <Popover.Trigger asChild>
                <button
                    aria-label="Configure agent"
                    className="flex h-9 min-w-0 max-w-[200px] items-center gap-2 rounded-lg px-2 text-[13px] text-copy-secondary outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-accent motion-reduce:transition-none"
                    data-testid={dataTestId.agentConfiguration}
                    title={selections.join(" · ")}
                    type="button"
                >
                    <SlidersHorizontal aria-hidden="true" className="size-4 shrink-0" />
                    <span className="min-w-0 truncate">
                        {selections.filter((value) => value.length > 0).join(" · ")}
                    </span>
                    <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    align="start"
                    aria-label="Agent configuration"
                    className="z-50 grid w-[min(calc(100vw-1.5rem),400px)] grid-cols-[112px_minmax(0,1fr)] overflow-hidden rounded-2xl border border-[#d5d9dc] bg-white shadow-[0_16px_42px_rgba(0,0,0,0.14)]"
                    role="dialog"
                    side="top"
                    sideOffset={10}
                >
                    <div
                        className="border-r border-border bg-surface-subtle/70 p-2"
                        role="tablist"
                        aria-label="Harness"
                    >
                        <span className="block px-2 pb-1.5 text-xs font-medium text-copy-tertiary">Harness</span>
                        {harness?.options.map((option) => (
                            <button
                                aria-selected={option.value === harness.value}
                                className="w-full truncate rounded-lg px-2 py-2 text-left text-[13px] outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-selected:bg-white aria-selected:font-medium aria-selected:shadow-sm motion-reduce:transition-none"
                                data-testid={dataTestId.agentHarness(option.value)}
                                disabled={harness.disabled}
                                key={option.value}
                                onClick={() => {
                                    if (option.value !== harness.value) {
                                        harness.onValueChange(option.value);
                                    }
                                }}
                                role="tab"
                                title={option.label}
                                type="button"
                            >
                                {option.tabLabel ?? option.label}
                            </button>
                        ))}
                    </div>
                    <div aria-busy={settingsLoading} className="grid min-h-44 content-start gap-3 p-3" role="tabpanel">
                        {settingsLoading ? (
                            <div
                                className="flex min-h-36 items-center justify-center"
                                data-testid={dataTestId.agentSettingsLoading}
                                role="status"
                            >
                                <LoaderCircle
                                    aria-label="Loading harness settings"
                                    className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none"
                                />
                            </div>
                        ) : settings.length === 0 ? (
                            <p className="self-center text-center text-xs text-muted-foreground">
                                This harness has no configurable settings.
                            </p>
                        ) : (
                            settings.map((control) => (
                                <div className="grid gap-1.5" key={control.id}>
                                    <span className="px-1 text-xs font-medium text-copy-tertiary">{control.label}</span>
                                    {control.kind === "select" ? (
                                        <Select
                                            disabled={control.disabled}
                                            label={control.label}
                                            onValueChange={control.onValueChange}
                                            options={control.options}
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
