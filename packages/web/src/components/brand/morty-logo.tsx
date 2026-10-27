import { cn } from "@/lib/utils";

/**
 * The Morty brand mark, rendered from the single artwork source in
 * `public/morty-logo.svg`. The tab icon and share card are generated from the
 * same file, so in-app and off-site marks cannot drift apart.
 *
 * The mark is decorative: every call site pairs it with the `Morty` wordmark, a
 * link name, or a button label.
 */
export function MortyLogoMark({ className, size = 36 }: { readonly className?: string; readonly size?: number }) {
    return (
        <img
            alt=""
            className={cn("shrink-0 select-none", className)}
            draggable={false}
            height={size}
            src="/morty-logo.svg"
            width={size}
        />
    );
}
