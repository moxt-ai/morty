import { Select as Primitive } from "radix-ui";
import { useState } from "react";
import { dataTestId } from "@/data-testid";

export function Select({
    compact = false,
    label,
    value,
    onValueChange,
    options,
    searchable = false,
    disabled = false,
    testId,
}: {
    readonly label: string;
    readonly value: string;
    readonly onValueChange: (value: string) => void;
    readonly options: readonly { readonly value: string; readonly label: string }[];
    readonly searchable?: boolean | undefined;
    readonly disabled?: boolean;
    readonly compact?: boolean;
    readonly testId?: string | undefined;
}) {
    const [search, setSearch] = useState("");
    const normalizedSearch = search.trim().toLocaleLowerCase();
    const visibleOptions =
        searchable && normalizedSearch.length > 0
            ? options.filter((option) =>
                  [option.label, option.value].some((candidate) =>
                      candidate.toLocaleLowerCase().includes(normalizedSearch),
                  ),
              )
            : options;
    return (
        <Primitive.Root
            disabled={disabled}
            onOpenChange={(open) => {
                if (!open) {
                    setSearch("");
                }
            }}
            onValueChange={onValueChange}
            value={value}
        >
            <Primitive.Trigger
                aria-label={label}
                className={`flex h-9 min-w-0 items-center justify-between gap-1.5 rounded-lg text-left text-[13px] outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 motion-reduce:transition-none ${compact ? "w-auto max-w-48 border-transparent bg-transparent px-2" : "w-full gap-2 border border-border bg-background px-3"}`}
                data-testid={testId}
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
                        {visibleOptions.map((option) => (
                            <Primitive.Item
                                data-testid={dataTestId.sessionConfigValue(option.value)}
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
                        {visibleOptions.length === 0 && (
                            <p className="px-3 py-2 text-center text-xs text-muted-foreground">No matching models</p>
                        )}
                    </Primitive.Viewport>
                    {searchable && (
                        <div className="border-t border-border bg-card p-1.5">
                            <div className="relative">
                                <Search
                                    aria-hidden="true"
                                    className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                                />
                                <input
                                    aria-label="Search models"
                                    autoComplete="off"
                                    className="h-8 w-full rounded-md border border-border bg-background pr-2 pl-8 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
                                    data-testid={dataTestId.modelSearch}
                                    onChange={(event) => setSearch(event.currentTarget.value)}
                                    onKeyDown={(event) => event.stopPropagation()}
                                    placeholder="Search models…"
                                    type="search"
                                    value={search}
                                />
                            </div>
                        </div>
                    )}
                    <Primitive.ScrollDownButton className="flex justify-center">
                        <ChevronDown aria-hidden="true" className="size-4" />
                    </Primitive.ScrollDownButton>
                </Primitive.Content>
            </Primitive.Portal>
        </Primitive.Root>
    );
}

import { Check, ChevronDown, ChevronUp, Search } from "lucide-react";
