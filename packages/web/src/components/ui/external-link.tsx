import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

/**
 * A link that opens in a new tab, so a visitor reading it keeps the page they came from.
 * Screen readers hear that it opens a new tab; sighted users see the caller's styling.
 */
export function ExternalLink({
    children,
    className = "",
    href,
}: {
    readonly children: ReactNode;
    readonly className?: string;
    readonly href: string;
}) {
    return (
        <a
            className={cn(
                "inline-flex items-center gap-1 rounded-sm outline-none transition-colors duration-150 motion-reduce:transition-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring",
                className,
            )}
            href={href}
            rel="noreferrer"
            target="_blank"
        >
            {children}
            <span className="sr-only">(opens in a new tab)</span>
        </a>
    );
}
