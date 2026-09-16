import { Select as Primitive } from "radix-ui";

export function Select({
    compact = false,
    label,
    value,
    onValueChange,
    options,
    disabled = false,
}: {
    readonly label: string;
    readonly value: string;
    readonly onValueChange: (value: string) => void;
    readonly options: readonly { readonly value: string; readonly label: string }[];
    readonly disabled?: boolean;
    readonly compact?: boolean;
}) {
    return (
        <Primitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
            <Primitive.Trigger
                aria-label={label}
                className={`flex h-9 min-w-0 items-center justify-between gap-1.5 rounded-lg text-left text-[13px] outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 motion-reduce:transition-none ${compact ? "w-auto max-w-48 border-transparent bg-transparent px-2" : "w-full gap-2 border border-border bg-background px-3"}`}
            >
                <span className="min-w-0 truncate">
                    <Primitive.Value placeholder={`Select ${label.toLowerCase()}`} />
                </span>
                <Primitive.Icon className="shrink-0">
                    <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
                </Primitive.Icon>
            </Primitive.Trigger>
            <Primitive.Portal>
                <Primitive.Content
                    position="popper"
                    sideOffset={4}
                    className="z-[60] max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] animate-cloud-enter overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-lg motion-reduce:animate-none"
                >
                    <Primitive.ScrollUpButton className="flex justify-center">
                        <ChevronUp aria-hidden="true" className="size-4" />
                    </Primitive.ScrollUpButton>
                    <Primitive.Viewport className="p-1">
                        {options.map((option) => (
                            <Primitive.Item
                                key={option.value}
                                value={option.value}
                                className="relative cursor-default select-none rounded-md py-2 pl-7 pr-3 text-[13px] outline-none data-[highlighted]:bg-accent"
                            >
                                <Primitive.ItemIndicator className="absolute left-2">
                                    <Check aria-hidden="true" className="size-3.5" />
                                </Primitive.ItemIndicator>
                                <Primitive.ItemText>{option.label}</Primitive.ItemText>
                            </Primitive.Item>
                        ))}
                    </Primitive.Viewport>
                    <Primitive.ScrollDownButton className="flex justify-center">
                        <ChevronDown aria-hidden="true" className="size-4" />
                    </Primitive.ScrollDownButton>
                </Primitive.Content>
            </Primitive.Portal>
        </Primitive.Root>
    );
}

import { Check, ChevronDown, ChevronUp } from "lucide-react";
