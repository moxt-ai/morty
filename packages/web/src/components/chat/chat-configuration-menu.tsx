import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { dataTestId } from "@/data-testid";
import { Select } from "../ui/option-select.tsx";
import { Popover } from "../ui/popover.tsx";

export interface ChatConfigurationControl {
    readonly disabled: boolean;
    readonly id: string;
    readonly label: string;
    readonly onValueChange: (value: string) => void;
    readonly options: readonly { readonly label: string; readonly value: string }[];
    readonly testId?: string | undefined;
    readonly value: string;
}

export function ChatConfigurationMenu({ controls }: { readonly controls: readonly ChatConfigurationControl[] }) {
    const [open, setOpen] = useState(false);
    const selections = controls.map(
        (control) => control.options.find((option) => option.value === control.value)?.label ?? control.value,
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
                    className="z-50 grid w-72 gap-3 rounded-2xl border border-[#d5d9dc] bg-white p-3 shadow-[0_16px_42px_rgba(0,0,0,0.14)]"
                    role="dialog"
                    side="top"
                    sideOffset={10}
                >
                    {controls.map((control) => (
                        <div className="grid gap-1.5" key={control.id}>
                            <span className="px-1 text-xs font-medium text-copy-tertiary">{control.label}</span>
                            <Select
                                disabled={control.disabled}
                                label={control.label}
                                onValueChange={control.onValueChange}
                                options={control.options}
                                testId={control.testId}
                                value={control.value}
                            />
                        </div>
                    ))}
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
