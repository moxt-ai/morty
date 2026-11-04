import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const inputBaseClassName =
    "w-full min-w-0 rounded-full border border-border bg-background text-foreground outline-none transition-[background-color] duration-150 motion-reduce:transition-none enabled:not-focus:hover:bg-accent focus:border-ring focus:outline-none! focus:shadow-[var(--focus-ring-shadow)] disabled:cursor-not-allowed disabled:border-border disabled:bg-morty-fill-opacity-2 disabled:text-morty-text-3 [type=number]:[-moz-appearance:textfield] [type=number]:[&::-webkit-inner-spin-button]:appearance-none [type=number]:[&::-webkit-outer-spin-button]:appearance-none";

/** Matches button text sizes: lg 40px, default 36px, sm 32px, xs 28px. */
const inputSizeClassName = {
    lg: "h-10 px-4 text-[15px]",
    default: "h-9 px-4 text-[13px]",
    sm: "h-8 px-3.5 text-[12px]",
    xs: "h-7 px-3 text-[12px]",
} as const;

export type InputSize = keyof typeof inputSizeClassName;

export const inputClassName = `${inputBaseClassName} ${inputSizeClassName.default}`;

export function Input({
    className = "",
    size = "default",
    ...props
}: Readonly<Omit<ComponentProps<"input">, "size"> & { readonly size?: InputSize }>) {
    return (
        <input data-slot="input" {...props} className={cn(inputBaseClassName, inputSizeClassName[size], className)} />
    );
}
