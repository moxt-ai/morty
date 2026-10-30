import type { ComponentProps } from "react";

export const inputClassName =
    "h-9 w-full min-w-0 rounded-md border border-border bg-background px-3 text-[13px] outline-none focus:border-ring focus:outline-none! focus:shadow-[var(--focus-ring-shadow)] disabled:cursor-not-allowed disabled:opacity-50";

export function Input({ className = "", ...props }: Readonly<ComponentProps<"input">>) {
    return <input data-slot="input" {...props} className={`${inputClassName} ${className}`} />;
}
