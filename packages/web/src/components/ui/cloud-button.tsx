import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

const variants = {
    primary: "border-transparent bg-foreground text-background hover:bg-foreground/85 active:bg-foreground/75",
    outline: "border-border bg-background text-foreground hover:bg-accent active:bg-morty-fill-opacity-4",
    ghost: "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground active:bg-morty-fill-opacity-4 active:text-foreground",
    destructive: "border-transparent bg-destructive text-white hover:bg-destructive/90 active:bg-destructive/70",
};
const sizes = {
    default: "min-h-9 px-4 py-1.5 text-[13px] has-[>svg:first-child+*]:pl-3 has-[>*+svg:last-child]:pr-3",
    lg: "h-10 px-6 text-16 has-[>svg:first-child+*]:pl-3 has-[>*+svg:last-child]:pr-3",
    sm: "min-h-8 px-4 py-1.5 text-xs has-[>svg:first-child+*]:pl-3 has-[>*+svg:last-child]:pr-3",
    xs: "h-7 px-3 text-xs has-[>svg:first-child+*]:pl-2 has-[>*+svg:last-child]:pr-2",
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
            className={`inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border font-medium outline-none transition-colors duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50 active:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 ${variants[variant]} ${sizes[size]} ${className}`}
        />
    );
}
