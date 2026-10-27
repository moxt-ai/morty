import type { ComponentProps } from "react";

export function Input({ className = "", ...props }: Readonly<ComponentProps<"input">>) {
    return (
        <input
            {...props}
            className={`h-9 w-full min-w-0 rounded-md border border-border bg-background px-3 text-[13px] outline-none keyboard-focus:focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        />
    );
}
