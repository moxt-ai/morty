import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

const variants = {
    primary: "border-transparent bg-primary text-primary-foreground hover:bg-primary/90",
    outline: "border-border bg-background text-foreground hover:bg-accent",
    ghost: "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
    destructive: "border-transparent bg-destructive text-white hover:bg-destructive/90",
};
const sizes = {
    default: "min-h-9 px-3 py-1.5 text-[13px]",
    sm: "min-h-8 px-3 py-1.5 text-xs",
    icon: "size-9 p-0 text-base",
};

export function Button({
    variant = "primary",
    size = "default",
    type = "button",
    asChild = false,
    className = "",
    ...props
}: Readonly<ComponentProps<"button">> & {
    readonly variant?: keyof typeof variants;
    readonly size?: keyof typeof sizes;
    readonly asChild?: boolean;
}) {
    const Component = asChild ? Slot.Root : "button";
    return (
        <Component
            {...props}
            {...(asChild ? {} : { type })}
            className={`inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border font-medium outline-none transition-colors duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background [&_svg]:pointer-events-none [&_svg]:shrink-0 ${variants[variant]} ${sizes[size]} ${className}`}
        />
    );
}
