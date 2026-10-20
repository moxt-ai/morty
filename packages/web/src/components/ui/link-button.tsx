import type { ComponentProps } from "react";

/**
 * A command rendered as inline text so it reads as part of a sentence while
 * remaining a real button for pointer and keyboard use. Carries no workflow
 * knowledge; callers own the label and the action.
 */
export function LinkButton({ className = "", ...props }: Readonly<ComponentProps<"button">>) {
    return (
        <button
            {...props}
            type={props.type ?? "button"}
            className={`inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium text-primary underline-offset-2 outline-none transition-colors duration-150 motion-reduce:transition-none hover:underline disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring/70 ${className}`}
        />
    );
}
