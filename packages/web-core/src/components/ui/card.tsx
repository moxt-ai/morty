import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

export function Card({
    asChild = false,
    className = "",
    ...props
}: Readonly<ComponentProps<"div">> & { readonly asChild?: boolean }) {
    const Component = asChild ? Slot.Root : "div";
    return (
        <Component
            {...props}
            className={`min-w-0 rounded-xl border border-border bg-card text-foreground shadow-sm ${className}`}
        />
    );
}
