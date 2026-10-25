import type { ComponentProps } from "react";

export function Input({ className = "", ...props }: Readonly<ComponentProps<"input">>) {
    return (
        <input
            {...props}
            className={`h-9 w-full min-w-0 rounded-md border border-border bg-background px-3 text-[13px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        />
    );
}
