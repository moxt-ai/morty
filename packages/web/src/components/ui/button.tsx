import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium outline-none transition-colors duration-150 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 active:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
    {
        defaultVariants: {
            size: "default",
            variant: "default",
        },
        variants: {
            size: {
                default: "h-9 px-4 py-2 has-[>svg:first-child+*]:pl-3 has-[>*+svg:last-child]:pr-3",
                icon: "size-9",
                lg: "h-10 px-6 has-[>svg:first-child+*]:pl-3 has-[>*+svg:last-child]:pr-3",
                sm: "h-8 gap-1.5 px-3 text-xs has-[>svg:first-child+*]:pl-3 has-[>*+svg:last-child]:pr-3",
                xs: "h-7 px-3 text-xs has-[>svg:first-child+*]:pl-2 has-[>*+svg:last-child]:pr-2",
            },
            variant: {
                default: "bg-foreground text-background shadow-xs hover:bg-foreground/85 active:bg-foreground/75",
                ghost: "hover:bg-accent hover:text-accent-foreground active:bg-morty-fill-opacity-4 active:text-accent-foreground",
                outline:
                    "border border-border bg-background hover:bg-accent hover:text-accent-foreground active:bg-morty-fill-opacity-4 active:text-accent-foreground",
                secondary:
                    "bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-morty-fill-opacity-4",
            },
        },
    },
);

export interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {}

export function Button({ className, size, type = "button", variant, ...props }: ButtonProps) {
    return (
        <button
            className={cn(buttonVariants({ className, size, variant }))}
            data-slot="button"
            type={type}
            {...props}
        />
    );
}
