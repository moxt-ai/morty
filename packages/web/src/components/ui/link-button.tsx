import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";
import { textLinkClassName } from "./text-link.ts";

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
            className={cn(
                "inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium outline-none",
                textLinkClassName,
                "disabled:cursor-not-allowed disabled:opacity-50",
                className,
            )}
        />
    );
}
