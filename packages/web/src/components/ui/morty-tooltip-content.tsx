import { Tooltip } from "radix-ui";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

export function MortyTooltipContent({
    className,
    children,
    ...props
}: ComponentPropsWithoutRef<typeof Tooltip.Content>) {
    return (
        <Tooltip.Content
            className={cn(
                "z-[140] rounded-[16px] bg-foreground px-2.5 py-1.5 text-xs text-background shadow-lg sm:z-[70]",
                className,
            )}
            {...props}
        >
            {children}
        </Tooltip.Content>
    );
}
