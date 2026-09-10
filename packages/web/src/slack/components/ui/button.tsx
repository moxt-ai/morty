import type { ComponentProps } from "react";

const variants = {
    primary: "rounded-lg border border-transparent bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
    outline: "rounded-lg border border-border bg-background text-foreground hover:bg-accent",
    ghost: "rounded-lg border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
    tab: "rounded-none border-b-2 border-transparent text-muted-foreground hover:text-foreground aria-selected:border-ring aria-selected:text-ring",
};
const sizes = {
    default: "min-h-9 px-3 py-1.5 text-[13px]",
    sm: "min-h-8 px-3 py-1.5 text-xs",
    icon: "size-9 p-0 text-base",
};

export type ButtonProps = Readonly<ComponentProps<"button">> & {
    readonly variant?: keyof typeof variants;
    readonly size?: keyof typeof sizes;
};

export function Button({
    variant = "primary",
    size = "default",
    type = "button",
    className = "",
    ...props
}: ButtonProps) {
    return (
        <button
            {...props}
            type={type}
            className={`inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 font-medium outline-none transition-colors duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background [&_svg]:pointer-events-none [&_svg]:shrink-0 ${variants[variant]} ${sizes[size]} ${className}`}
        />
    );
}
