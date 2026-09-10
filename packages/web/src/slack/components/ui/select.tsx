import { Select as Primitive } from "radix-ui";

export function Select({
    label,
    placeholder,
    options,
    value,
    onValueChange,
    name,
    required,
    disabled,
}: {
    readonly label: string;
    readonly placeholder: string;
    readonly options: readonly { readonly value: string; readonly label: string }[];
    readonly value?: string;
    readonly onValueChange?: (value: string) => void;
    readonly name?: string;
    readonly required?: boolean;
    readonly disabled?: boolean;
}) {
    return (
        <Primitive.Root
            {...(value === undefined ? {} : { value })}
            {...(onValueChange === undefined ? {} : { onValueChange })}
            {...(name === undefined ? {} : { name })}
            required={required ?? false}
            disabled={disabled ?? false}
        >
            <Primitive.Trigger
                aria-label={label}
                className="flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-left text-[13px] font-normal shadow-xs outline-none hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground [&>span:first-child]:truncate"
            >
                <Primitive.Value placeholder={placeholder} />
                <Primitive.Icon>
                    <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="size-4 shrink-0 text-muted-foreground"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                    >
                        <path d="m7 10 5 5 5-5" />
                    </svg>
                </Primitive.Icon>
            </Primitive.Trigger>
            <Primitive.Portal>
                <Primitive.Content
                    position="popper"
                    sideOffset={4}
                    className="z-[60] max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-lg"
                >
                    <Primitive.ScrollUpButton className="text-center text-xs">⌃</Primitive.ScrollUpButton>
                    <Primitive.Viewport className="p-1">
                        {options.map((option) => (
                            <Primitive.Item
                                key={option.value}
                                value={option.value}
                                className="relative flex cursor-default select-none items-center rounded-md py-2 pl-7 pr-3 text-[13px] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                            >
                                <Primitive.ItemIndicator className="absolute left-2">✓</Primitive.ItemIndicator>
                                <Primitive.ItemText>{option.label}</Primitive.ItemText>
                            </Primitive.Item>
                        ))}
                    </Primitive.Viewport>
                    <Primitive.ScrollDownButton className="text-center text-xs">⌄</Primitive.ScrollDownButton>
                </Primitive.Content>
            </Primitive.Portal>
        </Primitive.Root>
    );
}
