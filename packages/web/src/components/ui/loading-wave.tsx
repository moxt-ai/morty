import { cn } from "../../lib/utils.ts";

/**
 * Dot sizes, gaps, and rise for each whole-mark width. The three dots plus two
 * gaps add up to the mark's width: `inline` is 16px so it lines up with inline
 * text and icons beside it, `sm` is the standalone 36px mark, and `lg` is the
 * 42px mark of the whole-document loading page.
 */
const loadingWaveSizes = {
    inline: { dot: "size-1", gap: "gap-0.5", rise: "[--loading-wave-rise:2.5px]" },
    sm: { dot: "size-[8px]", gap: "gap-[6px]", rise: "[--loading-wave-rise:5.5px]" },
    lg: { dot: "size-[10px]", gap: "gap-[6px]", rise: "[--loading-wave-rise:7px]" },
} as const;

/**
 * Three dots rising and falling in sequence: the product's loading mark, sized
 * either for a whole document or inline beside a status line. Decorative — the
 * surrounding `role="status"` element carries the announcement, so screen
 * readers hear one label instead of the dots.
 */
export function LoadingWave({
    className,
    size = "sm",
}: {
    readonly className?: string;
    readonly size?: keyof typeof loadingWaveSizes;
}) {
    const { dot, gap, rise } = loadingWaveSizes[size];
    return (
        <span aria-hidden="true" className={cn("inline-flex items-center", gap, className)}>
            {[0, 1, 2].map((index) => (
                <span
                    className={cn(
                        dot,
                        rise,
                        "animate-loading-wave rounded-full bg-morty-text-4 motion-reduce:animate-none",
                    )}
                    data-loading-dot=""
                    key={index}
                    style={{ animationDelay: `${index * 120}ms` }}
                />
            ))}
        </span>
    );
}
