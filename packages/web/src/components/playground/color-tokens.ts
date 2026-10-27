/** A color variable declared in `:root`, grouped by the section it belongs to. */
export interface ColorToken {
    /** The section heading that organizes the variable in `styles.css`. */
    readonly group: string;
    /** The custom property, such as `--primary`. */
    readonly variable: string;
    /** The Tailwind background utility, such as `bg-primary`. */
    readonly utility: string;
}

type TokenSection = readonly [group: string, variables: readonly string[]];

/**
 * Mirrors the color variables declared in `styles.css`. Each one has a
 * `--color-<name>: var(--<name>)` alias, so its Tailwind utility is
 * `bg-<name>`. Values are read from the live document, not duplicated here.
 */
const SECTIONS: readonly TokenSection[] = [
    [
        "shadcn (Morty light)",
        [
            "--background",
            "--foreground",
            "--card",
            "--card-foreground",
            "--popover",
            "--popover-foreground",
            "--primary",
            "--primary-foreground",
            "--secondary",
            "--secondary-foreground",
            "--muted",
            "--muted-foreground",
            "--accent",
            "--accent-foreground",
            "--accent-active",
            "--destructive",
            "--border",
            "--input",
            "--ring",
        ],
    ],
    [
        "Morty interaction layer",
        [
            "--morty-brand-1",
            "--morty-brand-6",
            "--morty-brand-7",
            "--morty-text-2",
            "--morty-text-3",
            "--morty-text-4",
            "--morty-fill-white",
            "--morty-fill-opacity-1",
            "--morty-fill-opacity-2",
            "--morty-fill-opacity-3",
            "--morty-fill-opacity-4",
        ],
    ],
    [
        "Morty semantic tokens",
        [
            "--success",
            "--copy-secondary",
            "--surface-subtle",
            "--surface-dialog-composite",
            "--user-message-surface",
            "--sidebar",
            "--surface-elevated",
            "--primary-subtle",
        ],
    ],
];

export const COLOR_TOKENS: readonly ColorToken[] = SECTIONS.flatMap(([group, variables]) =>
    variables.map((variable) => ({ group, utility: `bg-${variable.slice(2)}`, variable })),
);

export const COLOR_SECTIONS: readonly { readonly group: string; readonly tokens: readonly ColorToken[] }[] =
    SECTIONS.map(([group]) => ({ group, tokens: COLOR_TOKENS.filter((token) => token.group === group) }));
