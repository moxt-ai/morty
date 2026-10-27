import { Check, ChevronDown, Search, SearchX, X } from "lucide-react";
import { Select as Primitive } from "radix-ui";
import { type ComponentProps, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { dataTestId } from "@/data-testid";
import { cn } from "@/lib/utils";
import {
    type OverlayContentOpenAutoFocus,
    overlaySurfacePanelClassName,
    overlaySurfaceRadiusClassName,
    overlayTriggerOffsetPx,
} from "./overlay-surface.ts";

/** A few pixels of scroll before the top wash appears, matching other edge fades. */
const TOP_FADE_THRESHOLD_PX = 4;

export function Select({
    compact = false,
    label,
    value,
    onValueChange,
    options,
    searchable = false,
    disabled = false,
    leading,
    placeholder,
    truncateOptions = false,
    testId,
    mutedWhenDisabled = true,
    valueLoading = false,
}: {
    readonly label: string;
    readonly value: string;
    readonly onValueChange: (value: string) => void;
    readonly options: readonly {
        readonly disabled?: boolean;
        readonly label: string;
        readonly title?: string;
        readonly value: string;
    }[];
    /** Shown in the closed field, beside the selected label. */
    readonly leading?: ReactNode;
    /** Closed-field text when no value is selected. Defaults to "Select <label>". */
    readonly placeholder?: string;
    readonly searchable?: boolean | undefined;
    readonly disabled?: boolean;
    readonly compact?: boolean;
    readonly truncateOptions?: boolean;
    readonly testId?: string | undefined;
    /** Disabled fields fade. Turn this off while a sibling value is loading, so only that value looks busy. */
    readonly mutedWhenDisabled?: boolean;
    /** The selected label is still being filled in. The field stays; only the value shows a skeleton. */
    readonly valueLoading?: boolean;
}) {
    const [search, setSearch] = useState("");
    const [topFadeVisible, setTopFadeVisible] = useState(false);
    const topFadeCleanup = useRef<(() => void) | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const restoreSearchFocus = useRef(false);
    const searchCaret = useRef<number | null>(null);
    useEffect(() => {
        const query = search;
        if (!restoreSearchFocus.current) {
            return;
        }
        const frame = requestAnimationFrame(() => {
            const input = searchInputRef.current;
            if (!restoreSearchFocus.current || input === null || input.value !== query) {
                return;
            }
            restoreSearchFocus.current = false;
            if (document.activeElement === input) {
                return;
            }
            input.focus({ preventScroll: true });
            const caret = searchCaret.current ?? input.value.length;
            input.setSelectionRange(caret, caret);
        });
        return () => {
            cancelAnimationFrame(frame);
        };
    }, [search]);
    const assignViewport = useCallback((node: HTMLDivElement | null) => {
        topFadeCleanup.current?.();
        topFadeCleanup.current = null;
        if (node === null) {
            setTopFadeVisible(false);
            return;
        }
        const syncTopFade = () => {
            const visible = node.scrollTop > TOP_FADE_THRESHOLD_PX;
            setTopFadeVisible((current) => (current === visible ? current : visible));
        };
        syncTopFade();
        node.addEventListener("scroll", syncTopFade, { passive: true });
        const frame = requestAnimationFrame(syncTopFade);
        topFadeCleanup.current = () => {
            cancelAnimationFrame(frame);
            node.removeEventListener("scroll", syncTopFade);
        };
    }, []);
    const normalizedSearch = search.trim().toLocaleLowerCase();
    const filtering = searchable && normalizedSearch.length > 0;
    const optionMatchesSearch = (option: (typeof options)[number]) =>
        [option.label, option.value].some((candidate) => candidate.toLocaleLowerCase().includes(normalizedSearch));
    const visibleOptions = filtering ? options.filter(optionMatchesSearch) : options;
    // Radix Select focuses the listbox when the selected item unmounts, which blurs this field.
    // Keep that item mounted and hidden so a search that excludes it does not steal focus.
    const concealedSelected = filtering
        ? options.find((option) => option.value === value && !optionMatchesSearch(option))
        : undefined;
    const renderedOptions = concealedSelected === undefined ? visibleOptions : [...visibleOptions, concealedSelected];
    return (
        <Primitive.Root
            disabled={disabled || valueLoading}
            onOpenChange={(open) => {
                if (!open) {
                    setSearch("");
                }
            }}
            onValueChange={onValueChange}
            value={value}
        >
            <Primitive.Trigger
                aria-busy={valueLoading}
                aria-label={label}
                className={cn(
                    "flex h-9 min-w-0 items-center justify-between gap-1.5 rounded-lg text-left text-[13px] outline-none transition-colors keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/50 motion-reduce:transition-none",
                    valueLoading
                        ? "pointer-events-none"
                        : mutedWhenDisabled
                          ? "hover:bg-accent disabled:opacity-50"
                          : "hover:bg-accent disabled:cursor-not-allowed",
                    compact
                        ? "w-auto max-w-48 border-transparent bg-transparent px-2"
                        : "w-full gap-2 border border-border bg-background px-3",
                )}
                data-testid={testId}
            >
                <span className="flex min-w-0 items-center gap-1.5">
                    {leading}
                    <span className="min-w-0 truncate">
                        {valueLoading ? (
                            <span
                                aria-hidden="true"
                                className="block h-3.5 w-24 max-w-full animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none"
                            />
                        ) : (
                            <Primitive.Value placeholder={placeholder ?? `Select ${label.toLowerCase()}`} />
                        )}
                    </span>
                </span>
                <Primitive.Icon className="shrink-0">
                    <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
                </Primitive.Icon>
            </Primitive.Trigger>
            <Primitive.Portal>
                <Primitive.Content
                    {...({
                        className: cn(
                            "z-[130] flex min-h-0 max-h-[var(--radix-select-content-available-height)] animate-cloud-enter flex-col overflow-hidden text-foreground motion-reduce:animate-none sm:z-[60]",
                            overlaySurfacePanelClassName,
                            overlaySurfaceRadiusClassName,
                            truncateOptions
                                ? "w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-1rem)]"
                                : "min-w-[var(--radix-select-trigger-width)]",
                        ),
                        onOpenAutoFocus: (event: Event) => {
                            event.preventDefault();
                            if (searchable) {
                                requestAnimationFrame(() => {
                                    searchInputRef.current?.focus({ preventScroll: true });
                                });
                            }
                        },
                        position: "popper",
                        sideOffset: overlayTriggerOffsetPx,
                    } satisfies ComponentProps<typeof Primitive.Content> & OverlayContentOpenAutoFocus)}
                >
                    {searchable && (
                        <div className="relative z-10 shrink-0 px-3 pt-3 pb-2">
                            <div className="relative">
                                <Search
                                    aria-hidden="true"
                                    className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                                />
                                <input
                                    aria-label="Search models"
                                    autoComplete="off"
                                    className={cn(
                                        "h-9 w-full rounded-full border border-border bg-background pl-8 text-[14px] outline-none keyboard-focus:focus-visible:border-ring keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/20 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none",
                                        search.length > 0 ? "pr-8" : "pr-2",
                                    )}
                                    data-testid={dataTestId.modelSearch}
                                    onChange={(event) => {
                                        restoreSearchFocus.current = true;
                                        searchCaret.current = event.currentTarget.selectionStart;
                                        setSearch(event.currentTarget.value);
                                    }}
                                    ref={searchInputRef}
                                    onKeyDown={(event) => event.stopPropagation()}
                                    placeholder="Search models…"
                                    type="search"
                                    value={search}
                                />
                                {search.length > 0 && (
                                    <button
                                        aria-label="Clear search"
                                        className="absolute top-1/2 right-2.5 flex size-3.5 -translate-y-1/2 items-center justify-center text-muted-foreground hover:text-foreground"
                                        onClick={() => setSearch("")}
                                        onPointerDown={(event) => {
                                            event.preventDefault();
                                        }}
                                        type="button"
                                    >
                                        <X aria-hidden="true" className="size-3.5" />
                                    </button>
                                )}
                            </div>
                            <div
                                aria-hidden="true"
                                className={cn(
                                    // Opaque surface to fully clear. Start from the panel fill, not a partial alpha.
                                    "pointer-events-none absolute inset-x-0 top-full h-8 bg-gradient-to-b from-background to-background/0 transition-opacity duration-150 motion-reduce:transition-none",
                                    topFadeVisible ? "opacity-100" : "opacity-0",
                                )}
                            />
                        </div>
                    )}
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                        <Primitive.Viewport
                            className={cn(
                                "h-full min-h-0 flex-1",
                                visibleOptions.length === 0
                                    ? "flex flex-col"
                                    : truncateOptions
                                      ? "w-full p-1"
                                      : "px-2.5 pt-1 pb-2.5",
                            )}
                            ref={searchable ? assignViewport : undefined}
                        >
                            {renderedOptions.map((option) => {
                                const concealed = option.value === concealedSelected?.value;
                                return (
                                    <Primitive.Item
                                        className={
                                            concealed
                                                ? "hidden"
                                                : cn(
                                                      "relative flex cursor-default select-none items-center rounded-full py-2 pr-4 pl-8.5 text-[13px] outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent",
                                                      truncateOptions && "w-full min-w-0",
                                                  )
                                        }
                                        data-testid={
                                            concealed ? undefined : dataTestId.sessionConfigValue(option.value)
                                        }
                                        disabled={option.disabled === true}
                                        hidden={concealed}
                                        key={option.value}
                                        title={
                                            concealed
                                                ? undefined
                                                : (option.title ?? (truncateOptions ? option.label : undefined))
                                        }
                                        value={option.value}
                                    >
                                        <Primitive.ItemIndicator className="absolute top-1/2 left-2 flex -translate-y-1/2 items-center justify-center">
                                            <Check aria-hidden="true" className="ml-1 size-3.5" />
                                        </Primitive.ItemIndicator>
                                        {truncateOptions ? (
                                            <Primitive.ItemText asChild>
                                                <span className="block truncate">{option.label}</span>
                                            </Primitive.ItemText>
                                        ) : (
                                            <Primitive.ItemText>{option.label}</Primitive.ItemText>
                                        )}
                                    </Primitive.Item>
                                );
                            })}
                            {visibleOptions.length === 0 && (
                                <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-2.5 text-center text-13">
                                    <div className="flex flex-col items-center gap-2.5 py-8">
                                        <span className="flex size-10 items-center justify-center rounded-full bg-morty-fill-opacity-2">
                                            <SearchX aria-hidden="true" className="size-4.5 text-morty-text-3" />
                                        </span>
                                        <div className="flex max-w-[14rem] flex-col gap-1">
                                            <p className="font-medium leading-snug text-secondary-foreground">
                                                No matching models
                                            </p>
                                            <p className="leading-snug text-morty-text-3">Try a different search.</p>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </Primitive.Viewport>
                    </div>
                </Primitive.Content>
            </Primitive.Portal>
        </Primitive.Root>
    );
}
