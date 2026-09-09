import { Select as Primitive } from "radix-ui";

export function Select({
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
}) {
    return (
        <Primitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
            <Primitive.Trigger
                aria-label={label}
                className="flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-50"
            >
                <Primitive.Value placeholder={`Select ${label.toLowerCase()}`} />
                <Primitive.Icon>⌄</Primitive.Icon>
            </Primitive.Trigger>
            <Primitive.Portal>
                <Primitive.Content
                    position="popper"
                    sideOffset={4}
                    className="z-[60] max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-lg"
                >
                    <Primitive.ScrollUpButton>⌃</Primitive.ScrollUpButton>
                    <Primitive.Viewport className="p-1">
                        {options.map((option) => (
                            <Primitive.Item
                                key={option.value}
                                value={option.value}
                                className="relative cursor-default select-none rounded-md py-2 pl-7 pr-3 text-[13px] outline-none data-[highlighted]:bg-accent"
                            >
                                <Primitive.ItemIndicator className="absolute left-2">✓</Primitive.ItemIndicator>
                                <Primitive.ItemText>{option.label}</Primitive.ItemText>
                            </Primitive.Item>
                        ))}
                    </Primitive.Viewport>
                    <Primitive.ScrollDownButton>⌄</Primitive.ScrollDownButton>
                </Primitive.Content>
            </Primitive.Portal>
        </Primitive.Root>
    );
}
