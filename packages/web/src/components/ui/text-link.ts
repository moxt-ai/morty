/**
 * Inline text link styling. A link is identified by color alone: the resting
 * primary color, a lighter hover, and a darker pressed state. Underlines are
 * deliberately absent, so prose with many links keeps its line rhythm and
 * command-like text embedded in a sentence stays readable.
 */
export const textLinkClassName =
    "text-primary transition-colors duration-150 motion-reduce:transition-none hover:text-primary-hover active:text-primary-active";

/** Same color-only treatment as `textLinkClassName`, in secondary gray. */
export const mutedTextLinkClassName =
    "text-copy-secondary transition-colors duration-150 motion-reduce:transition-none hover:text-foreground active:text-foreground";

/** Near-black text. Rest is foreground, hover lightens, and press returns to foreground. */
export const darkTextLinkClassName =
    "text-foreground transition-colors duration-150 motion-reduce:transition-none hover:text-copy-secondary active:text-foreground";
