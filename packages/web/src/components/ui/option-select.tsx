import { Select as Primitive } from "radix-ui";
import { useState } from "react";
import { dataTestId } from "@/data-testid";
import { cn } from "@/lib/utils";
import { overlaySurfacePanelClassName, overlaySurfaceRadiusClassName } from "./overlay-surface.ts";

export function Select({
    compact = false,
    label,
    value,
    onValueChange,
    options,
    searchable = false,
    disabled = false,
    truncateOptions = false,
    testId,
    previewOpen = false,
}: {
    readonly label: string;
    readonly value: string;
    readonly onValueChange: (value: string) => void;
    readonly options: readonly { readonly value: string; readonly label: string }[];
    readonly searchable?: boolean | undefined;
    readonly disabled?: boolean;
    readonly compact?: boolean;
    readonly truncateOptions?: boolean;
    readonly testId?: string | undefined;
    /** TEMP style-tuning preview: forces the listbox open. Remove with chat-configuration-menu-preview.ts. */
    readonly previewOpen?: boolean;
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
            {...(previewOpen ? { open: true } : {})}
            onOpenChange={(open) => {
                if (previewOpen) {
                    return;
                }
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
                    className={cn(
                        "z-[60] flex min-h-0 max-h-[var(--radix-select-content-available-height)] animate-cloud-enter flex-col overflow-hidden text-foreground motion-reduce:animate-none",
                        overlaySurfacePanelClassName,
                        overlaySurfaceRadiusClassName,
                        truncateOptions
                            ? "w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-1rem)]"
                            : "min-w-[var(--radix-select-trigger-width)]",
                    )}
                >
                    {searchable && (
                        <div className="relative z-10 shrink-0 px-3 pt-3 pb-1">
                            <div className="relative">
                                <Search
                                    aria-hidden="true"
                                    className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                                />
                                <input
                                    aria-label="Search models"
                                    autoComplete="off"
                                    className="h-9 w-full rounded-full border border-border bg-background pr-2 pl-8 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
                                    data-testid={dataTestId.modelSearch}
                                    onChange={(event) => setSearch(event.currentTarget.value)}
                                    onKeyDown={(event) => event.stopPropagation()}
                                    placeholder="Search models…"
                                    type="search"
                                    value={search}
                                />
                            </div>
                            <div
                                aria-hidden="true"
                                className="pointer-events-none absolute inset-x-0 top-full h-8 bg-gradient-to-b from-card/90 to-card/0"
                            />
                        </div>
                    )}
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                        <Primitive.Viewport
                            className={
                                truncateOptions ? "h-full w-full min-h-0 flex-1 p-1" : "h-full min-h-0 flex-1 p-1"
                            }
                        >
                            {visibleOptions.map((option) => (
                                <Primitive.Item
                                    data-testid={dataTestId.sessionConfigValue(option.value)}
                                    key={option.value}
                                    title={truncateOptions ? option.label : undefined}
                                    value={option.value}
                                    className={`relative cursor-default select-none rounded-md py-2 pl-7 pr-3 text-[13px] outline-none data-[highlighted]:bg-accent ${truncateOptions ? "w-full min-w-0" : ""}`}
                                >
                                    <Primitive.ItemIndicator className="absolute top-1/2 left-2 flex -translate-y-1/2 items-center justify-center">
                                        <Check aria-hidden="true" className="size-3.5" />
                                    </Primitive.ItemIndicator>
                                    {truncateOptions ? (
                                        <Primitive.ItemText asChild>
                                            <span className="block truncate">{option.label}</span>
                                        </Primitive.ItemText>
                                    ) : (
                                        <Primitive.ItemText>{option.label}</Primitive.ItemText>
                                    )}
                                </Primitive.Item>
                            ))}
                            {visibleOptions.length === 0 && (
                                <p className="px-3 py-2 text-center text-xs text-muted-foreground">
                                    No matching models
                                </p>
                            )}
                        </Primitive.Viewport>
                    </div>
                </Primitive.Content>
            </Primitive.Portal>
        </Primitive.Root>
    );
}

import { Check, ChevronDown, Search } from "lucide-react";
