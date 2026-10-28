import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Gap between buttons in a group, anchored on the 40px group's 12px gap
 * (`gap = button height / 2 - 8`) so every smaller size keeps the same rhythm.
 * The same scale applies to stacked and horizontal groups. Pair the group
 * with buttons of the same `size`.
 */
export const buttonGroupGapClassName = {
    default: "gap-2.5", // 36px buttons → 10px
    lg: "gap-3", // 40px buttons → 12px
    sm: "gap-2", // 32px buttons → 8px
    xs: "gap-1.5", // 28px buttons → 6px
} as const;

export type ButtonGroupSize = keyof typeof buttonGroupGapClassName;

/** Actions that share one gap for the whole group, stacked or in a row. */
export function ButtonGroup({
    children,
    className = "",
    orientation = "vertical",
    size = "default",
}: {
    readonly children: ReactNode;
    readonly className?: string;
    readonly orientation?: "horizontal" | "vertical";
    readonly size?: ButtonGroupSize;
}) {
    return (
        <div
            className={cn(
                "flex",
                orientation === "vertical" ? "flex-col" : "flex-row flex-wrap",
                buttonGroupGapClassName[size],
                className,
            )}
        >
            {children}
        </div>
    );
}
